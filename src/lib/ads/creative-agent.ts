/**
 * creative-agent — the deterministic loop behind Dahlia, the Ad Creative Agent (a box lane, peer to
 * [[media-buyer-agent|Bianca]] under Max). She keeps Bianca's ready-to-test bin stocked with fresh,
 * fully-backed static ads so the media-buyer test loop never starves for angles.
 *
 * The pipeline per creative, all grounded so it can auto-publish with NO human gate:
 *   [[product-intelligence]] getProductIntelligence  →  [[creative-brief]] selectAngles + buildCreativeBrief
 *   →  [[creative-generate]] generateCreative (Nano Banana Pro)  →  [[creative-qa]] qaCreative (vision gate,
 *   regenerate on fail)  →  insert into the bin ([[../tables/ad_campaigns]] status='ready' + a static
 *   [[../tables/ad_videos]] child in the `ad-tool` bucket + a battle-tested Shopify-PDP landing_url).
 *
 * Deterministic Node lane (mirrors [[media-buyer/agent]]) — the only metered call is image gen + one
 * vision-QA pass; no Max session. The cadence cron ([[../inngest/ad-creative-cadence]]) enqueues a job
 * per product whose bin is below the floor. See [[../../../docs/brain/lifecycles/ad-creative.md]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { getProductIntelligence, type PIReview } from "@/lib/product-intelligence";
import { selectAngles, buildCreativeBrief, buildMetaCopy, type ScoredAngle } from "@/lib/ads/creative-brief";
import { loadCreativeLearning, nextTreatmentFor, recordCombinationGenerated, angleKey } from "@/lib/ads/creative-learning";
import { getProvenCompetitorAngles } from "@/lib/ads/creative-sourcing";
import { generateCreative } from "@/lib/ads/creative-generate";
import { qaCreative, qaCreativeViaBoxSession, type QcSessionDispatcher } from "@/lib/ads/creative-qa";
import { uploadBuffer, signedUrl } from "@/lib/ad-storage";
import { listReadyToTest } from "@/lib/ads/ready-to-test";
import { isAdvertisedProduct, listAdvertisedProductIds } from "@/lib/advertised-products";
import { META_CAPS } from "@/lib/ad-tool-config";

type Admin = ReturnType<typeof createAdminClient>;

/** Default target depth per product for the ready-to-test bin — kept small; the media buyer tests a
 *  handful at a time and creatives fatigue, so we top up rather than stockpile. */
export const DEFAULT_BIN_FLOOR = 4;
/** Cap how many creatives one job produces, so a deep deficit can't run away on image-gen cost. */
const MAX_PER_JOB = 4;
/** Regenerate-on-QA-fail attempts per creative before giving up on that angle. Bumped 2→3 (2026-07-13)
 *  so the stricter render QC (packaging-text garble now in scope) has room to land a clean take rather
 *  than starving the batch below its target count. */
const MAX_QA_ATTEMPTS = 3;

export interface StockedCreative {
  productId: string;
  angleHook: string;
  campaignId: string | null;
  ok: boolean;
  reason?: string;
  qaIssues?: string[];
}

export interface AdCreativeRunResult {
  workspaceId: string;
  stocked: StockedCreative[];
  produced: number;
  failed: number;
}

/** Weight-loss / transformation reviews — the SDK surfaces featured/recent/withPhotos, but the biggest
 *  acquisition stories ("I lost 84 lbs") live deeper in the corpus, so scan directly. */
async function loadTransformationStories(admin: Admin, workspaceId: string, productId: string): Promise<PIReview[]> {
  const { data } = await admin
    .from("product_reviews")
    .select("id, reviewer_name, rating, title, body, summary, smart_quote, verified_purchase, featured, images, cancel_relevance, published_at")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .or("body.ilike.%pounds%,body.ilike.% lbs%,body.ilike.%lost %,smart_quote.ilike.%lbs%")
    .order("published_at", { ascending: false })
    .limit(40);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((r) => /\b(\d{1,3})\s*(lbs?|pounds)\b|\b(lost|dropped|shed)\s+\d/i.test(`${r.body ?? ""} ${r.smart_quote ?? ""} ${r.title ?? ""}`))
    .map((r) => ({ ...r, images: Array.isArray(r.images) ? (r.images as unknown[]).filter((u): u is string => typeof u === "string" && /^https?:/.test(u)) : [] })) as PIReview[];
}

/** Resolve the ad destination for a product — the BATTLE-TESTED Shopify PDP
 *  `{shopify_primary_domain}/products/{handle}` (e.g. `https://superfoodscompany.com/products/superfood-tabs`).
 *  Policy (CEO, 2026-07-10): cold creatives run to the proven Shopify PDP; the in-house storefront /
 *  advertorial-variant landers (`{storefront_domain}/{handle}?variant=…`) are a LATER experiment, tested
 *  only once a creative is a proven winner. (`shopify_domain` is an unreliable/truncated legacy field —
 *  never use it; `shopify_primary_domain` is the online-store primary domain, mirrored in
 *  `workspaces.ad_destination_domains`.) Storefront is the fallback only if no primary domain is set. */
async function resolveLandingUrl(admin: Admin, workspaceId: string, productHandle: string): Promise<string | null> {
  const { data: ws } = await admin
    .from("workspaces")
    .select("shopify_primary_domain, storefront_domain, storefront_slug")
    .eq("id", workspaceId)
    .maybeSingle();
  const w = ws as { shopify_primary_domain?: string | null; storefront_domain?: string | null; storefront_slug?: string | null } | null;
  if (w?.shopify_primary_domain) return `https://${w.shopify_primary_domain}/products/${productHandle}`;
  if (w?.storefront_domain) return `https://${w.storefront_domain}/${productHandle}`;
  if (w?.storefront_slug) return `https://shopcx.ai/store/${w.storefront_slug}/${productHandle}`;
  return null;
}

/** How many ready-to-test creatives a product currently has in the bin. */
async function currentBinDepth(admin: Admin, workspaceId: string, productId: string): Promise<number> {
  const { readyToTest } = await listReadyToTest(admin, { workspaceId });
  if (!readyToTest.length) return 0;
  const ids = readyToTest.map((r) => r.ad_campaign_id);
  const { data } = await admin.from("ad_campaigns").select("id").eq("workspace_id", workspaceId).eq("product_id", productId).in("id", ids);
  return (data ?? []).length;
}

/** Insert one finished static creative into the ready-to-test bin (mirrors the canonical
 *  /api/ads/upload-static path: angle → campaign(ready) → static ad_videos(ready) in the ad-tool
 *  bucket → landing_url). Returns the campaign id. */
async function insertReadyCreative(
  admin: Admin,
  workspaceId: string,
  productId: string,
  productHandle: string,
  productTitle: string,
  angle: ScoredAngle,
  metaCopy: { headline: string; primaryText: string; description: string },
  image: { buffer: Buffer; mimeType: string },
): Promise<string | null> {
  const { data: angleRow } = await admin
    .from("product_ad_angles")
    .insert({
      workspace_id: workspaceId, product_id: productId,
      hook_slug: "results_first", lf8_slot: 8,
      lead_benefit_anchor: angle.leadBenefit.slice(0, 120),
      hook_one_liner: angle.hook.slice(0, 120),
      urgency_lever: "none", generated_by: "ad-creative-agent", is_active: true,
      meta_headline: metaCopy.headline.slice(0, META_CAPS.headline),
      meta_primary_text: metaCopy.primaryText.slice(0, META_CAPS.primary_text),
      meta_description: metaCopy.description.slice(0, META_CAPS.description),
    })
    .select("id").single();

  const name = `Dahlia · ${productTitle} · ${angle.source}`;
  const { data: campaign, error: cErr } = await admin
    .from("ad_campaigns")
    .insert({ workspace_id: workspaceId, product_id: productId, name, angle_id: angleRow?.id ?? null, status: "ready" })
    .select("id").single();
  if (cErr || !campaign) return null;
  const campaignId = (campaign as { id: string }).id;

  const ext = image.mimeType.includes("png") ? "png" : "jpg";
  const { data: vrow } = await admin
    .from("ad_videos")
    .insert({ workspace_id: workspaceId, campaign_id: campaignId, format: "feed_4x5", media_kind: "static", status: "pending", meta: { archetype: "before_after", generated_by: "ad-creative-agent" } })
    .select("id").single();
  const videoId = (vrow as { id: string } | null)?.id;
  if (videoId) {
    const storagePath = `finals/${workspaceId}/${videoId}.${ext}`;
    await uploadBuffer(storagePath, image.buffer, image.mimeType);
    const url = await signedUrl(storagePath);
    await admin.from("ad_videos").update({ static_jpg_url: url, status: "ready", meta: { archetype: "before_after", generated_by: "ad-creative-agent", storage_path: storagePath } }).eq("id", videoId);
  }

  const landingUrl = await resolveLandingUrl(admin, workspaceId, productHandle);
  if (landingUrl) await admin.from("ad_campaigns").update({ landing_url: landingUrl }).eq("id", campaignId);

  return campaignId;
}

/** Generate + QA + bin-insert `count` fresh creatives for one product, cycling through its top unused
 *  angles. Skips angles already represented by an existing campaign so we add variety, not dupes.
 *
 *  QC path — when `qcDispatcher` is set, the QC pass runs as a `claude -p` box session on Max
 *  ([[creative-qa]] qaCreativeViaBoxSession — dahlia-creative-qc-via-box-session Phase 1) so the
 *  lane never needs an ANTHROPIC_API_KEY; otherwise it falls back to the direct Opus vision API
 *  path ([[creative-qa]] qaCreative). Fail-closed on either path — any error → `pass:false`. */
async function stockProduct(
  admin: Admin,
  workspaceId: string,
  productId: string,
  count: number,
  qcDispatcher?: QcSessionDispatcher,
): Promise<StockedCreative[]> {
  const out: StockedCreative[] = [];
  const pi = await getProductIntelligence(admin, workspaceId, productId);
  const product = pi.product as { title?: string; handle?: string } | null;
  if (!product?.handle) return [{ productId, angleHook: "", campaignId: null, ok: false, reason: "product_missing_handle" }];
  const productTitle = product.title ?? "Product";

  const stories = await loadTransformationStories(admin, workspaceId, productId);
  const ownAngles = selectAngles(pi, stories);

  // Pool in PROVEN competitor angles from THIS product's deliberately-chosen competitors (CEO 2026-07-12):
  // market-validated hooks + their winning GRAPHIC, ranked by days-running. Read by product_id — the scout
  // tagged each skeleton with the product its competitor was chosen for, so imitate reads a product's own
  // shelf (not a coffee/weight substring guess). Each carries its image so the generator can do COMPOSITION
  // TRANSFER — reuse the competitor's winning layout, swap in our content.
  const competitorAngles: ScoredAngle[] = (await getProvenCompetitorAngles(admin, workspaceId, { productId, minDaysRunning: 45, limit: 6 }).catch(() => []))
    .filter((c) => c.hook)
    .map((c) => ({
      hook: c.hook as string,
      source: "competitor",
      leadBenefit: c.mechanismClaim ?? "proven competitor angle",
      acquisitionPower: 9, // proven in market
      retentionTruth: 5,
      commodity: false,
      hasRealPhoto: false,
      reasons: [`proven competitor ad (${c.daysRunning ?? "?"}d running${c.advertiser ? `, ${c.advertiser}` : ""})`],
      raw: { imageUrl: c.imageUrl, mechanism: c.mechanismClaim, proof: c.proof } as Record<string, unknown>,
    }));
  const ranked = [...competitorAngles, ...ownAngles];

  // Combination-aware selection (CEO 2026-07-10): a concept is only RETIRED after several distinct
  // combinations fail — a failed angle×creative×copy×destination is not a dead angle. So we drop only
  // RETIRED concepts, and for each surviving concept pick a FRESH combination (an untried treatment,
  // biased toward historically-winning treatments). The learning ledger makes each cycle smarter.
  const learning = await loadCreativeLearning(admin, workspaceId, productId);
  const eligible = ranked.filter((a) => !learning.byAngle.get(angleKey(a.hook))?.retired);

  // ── Explore/exploit slot allocation (CEO 2026-07-10) ──────────────────────────────────────────────
  // Keep the bin a MIX so Bianca always has both to launch:
  //   • EXPLOIT — a fresh COMBINATION of a proven WINNING concept (double down on what converts, but a
  //     new treatment/execution so we don't just re-run the fatiguing ad).
  //   • EXPLORE — a fresh, unproven concept (find the NEXT winner before the current one fatigues).
  // Target a 2:2 split; if there are no winners yet (early days), it's all explore — self-adjusting.
  const isWon = (a: ScoredAngle) => (learning.byAngle.get(angleKey(a.hook))?.won ?? 0) > 0;
  const exploitPool = eligible.filter(isWon)
    .sort((a, b) => (learning.byAngle.get(angleKey(b.hook))?.won ?? 0) - (learning.byAngle.get(angleKey(a.hook))?.won ?? 0));
  const explorePool = eligible.filter((a) => !isWon(a))
    .sort((a, b) =>
      // IMITATE-FIRST (CEO 2026-07-12): explores draw from the product's scouted COMPETITOR angles
      // BEFORE our own unproven concepts — Dylan's flow: "she goes to the scouted ads for that
      // competitor list and finds great examples to explore." A competitor angle is market-validated
      // (a rival is profitably scaling it), so it's the strongest unproven bet. Own angles fill the rest.
      ((a.source === "competitor" ? 0 : 1) - (b.source === "competitor" ? 0 : 1))
      || ((learning.byAngle.get(angleKey(a.hook))?.tried ?? 0) - (learning.byAngle.get(angleKey(b.hook))?.tried ?? 0))
      || (b.acquisitionPower - a.acquisitionPower));

  // Build the slot plan: aim for half exploit / half explore, then backfill from whichever pool has more.
  const plan: Array<{ angle: ScoredAngle; intent: "exploit" | "explore" }> = [];
  let ei = 0, xi = 0;
  const wantExploit = Math.min(Math.floor(count / 2), exploitPool.length);
  for (let n = 0; n < wantExploit; n++) plan.push({ angle: exploitPool[ei++], intent: "exploit" });
  while (plan.length < count && xi < explorePool.length) plan.push({ angle: explorePool[xi++], intent: "explore" });
  while (plan.length < count && ei < exploitPool.length) plan.push({ angle: exploitPool[ei++], intent: "exploit" });
  if (!plan.length) for (const a of (eligible.length ? eligible : ranked).slice(0, count)) plan.push({ angle: a, intent: "explore" });

  // Assign a DISTINCT treatment per creative up front — so a batch of the same concept spreads across
  // treatments (before_after, testimonial, big_claim, …) instead of all landing on the top one. Excludes
  // both ledger-tried treatments AND treatments already assigned earlier in THIS batch (the in-loop
  // `learning` snapshot doesn't update between generations, which is what made the last 3 all before_after).
  const batchUsed = new Map<string, Set<string>>();
  const planned = plan.map(({ angle, intent }) => {
    const ak = angleKey(angle.hook);
    const tried = learning.byAngle.get(ak)?.triedTreatments ?? new Set<string>();
    const used = batchUsed.get(ak) ?? new Set<string>();
    const excluded = new Set<string>([...tried, ...used]);
    const treatment = (learning.bestTreatments.find((t) => !excluded.has(t))
      ?? learning.bestTreatments.find((t) => !used.has(t))
      ?? nextTreatmentFor(ak, learning)) as (typeof learning.bestTreatments)[number];
    used.add(treatment); batchUsed.set(ak, used);
    return { angle, intent, treatment };
  });

  for (const { angle, intent, treatment } of planned) {
    const ak = angleKey(angle.hook);
    let landed = false;
    let lastIssues: string[] = [];
    for (let attempt = 0; attempt < MAX_QA_ATTEMPTS && !landed; attempt++) {
      try {
        const brief = await buildCreativeBrief(pi, angle, stories);
        // Competitor-sourced angle → COMPOSITION TRANSFER: pass its winning graphic as the design
        // reference and instruct Nano Banana to keep the layout but swap in our product/copy/proof.
        const isCompetitor = angle.source === "competitor";
        const refUrl = isCompetitor ? (angle.raw?.imageUrl as string | undefined) : undefined;
        const gen = await generateCreative(workspaceId, brief, { treatment, designReferenceUrl: refUrl, compositionTransfer: isCompetitor && !!refUrl });
        const verdict = qcDispatcher
          ? await qaCreativeViaBoxSession({ buffer: gen.buffer, expectedCopy: gen.expectedCopy, hasTransformation: !!brief.transformation }, qcDispatcher)
          : await qaCreative(workspaceId, { buffer: gen.buffer, expectedCopy: gen.expectedCopy, hasTransformation: !!brief.transformation });
        if (!verdict.pass) { lastIssues = verdict.issues; continue; }
        // Real Meta copy from the grounded brief — a proof-led caption, a benefit headline (never the
        // offer), and the offer in the description; de-branded for competitor imitations ([[creative-brief]]
        // buildMetaCopy). Replaces the old hook+fragment concatenation that shipped "I lost 40+ pounds!
        // Appetite suppression/craving control" with the discount jammed into the headline (2026-07-13).
        const metaCopy = buildMetaCopy(brief);
        const campaignId = await insertReadyCreative(admin, workspaceId, productId, product.handle, productTitle, angle, metaCopy, { buffer: gen.buffer, mimeType: gen.mimeType });
        // Record the COMBINATION (concept × creative treatment × copy × destination) as pending — the
        // media buyer stamps its outcome later, feeding the learning flywheel.
        await recordCombinationGenerated(admin, {
          workspaceId, productId, angleKey: ak, adCampaignId: campaignId, intent,
          elements: { treatment, headline: metaCopy.headline, description: metaCopy.primaryText, cta: "Shop now", destinationUrl: await resolveLandingUrl(admin, workspaceId, product.handle) },
        });
        out.push({ productId, angleHook: angle.hook, campaignId, ok: !!campaignId, reason: campaignId ? undefined : "bin_insert_failed", qaIssues: verdict.issues.length ? verdict.issues : undefined });
        landed = !!campaignId;
      } catch (err) {
        lastIssues = [err instanceof Error ? err.message : String(err)];
      }
    }
    if (!landed) out.push({ productId, angleHook: angle.hook, campaignId: null, ok: false, reason: "qa_or_gen_failed", qaIssues: lastIssues });
  }
  return out;
}

/**
 * Run the ad-creative loop for a workspace. Called by the box lane (`runAdCreativeJob`).
 * `opts.productId` + `opts.count` targets one product (the cadence cron's per-product jobs);
 * with no productId it tops up every intelligence-backed product to `binFloor`.
 *
 * `opts.qcDispatcher` — when set, the per-creative QC pass runs as a `claude -p` box session on
 * Max via the caller's dispatcher (dahlia-creative-qc-via-box-session Phase 1: the ad-creative
 * lane never needs an ANTHROPIC_API_KEY). When unset, the loop falls back to the direct Opus
 * vision API path so callers without a spawn context still work; both paths fail-closed.
 */
export async function runAdCreativeLoop(
  admin: Admin,
  opts: { workspaceId: string; productId?: string; count?: number; binFloor?: number; qcDispatcher?: QcSessionDispatcher },
): Promise<AdCreativeRunResult> {
  const { workspaceId, qcDispatcher } = opts;
  const binFloor = opts.binFloor ?? DEFAULT_BIN_FLOOR;
  const stocked: StockedCreative[] = [];

  const targets: Array<{ productId: string; count: number }> = [];
  if (opts.productId) {
    // Per-product path (the cadence's per-product job). Gate the single target on
    // is_advertised so a stray productId snuck into an ad-creative job never yields creatives
    // for an attachment SKU. Attachment SKU → return zero targets, no work.
    const advertised = await isAdvertisedProduct(admin, opts.productId);
    if (advertised) {
      targets.push({ productId: opts.productId, count: Math.min(opts.count ?? binFloor, MAX_PER_JOB) });
    }
  } else {
    // Every product that HAS ad intelligence (an angle row), topped up to the floor.
    const { data: angleProducts } = await admin
      .from("product_ad_angles").select("product_id").eq("workspace_id", workspaceId);
    const angleProductIds = [...new Set(((angleProducts ?? []) as Array<{ product_id: string }>).map((r) => r.product_id).filter(Boolean))];
    // Hero-product advertising gate ([[../../libraries/advertised-products]]): a stray
    // product_ad_angles row for an attachment SKU never earns Dahlia work — only rows in
    // listAdvertisedProductIds survive the intersect. Empty gate ⇒ no targets, no fallback.
    const advertisedIds = new Set(await listAdvertisedProductIds(admin, workspaceId));
    const productIds = angleProductIds.filter((id) => advertisedIds.has(id));
    for (const productId of productIds) {
      const depth = await currentBinDepth(admin, workspaceId, productId);
      const deficit = binFloor - depth;
      if (deficit > 0) targets.push({ productId, count: Math.min(deficit, MAX_PER_JOB) });
    }
  }

  for (const t of targets) {
    const results = await stockProduct(admin, workspaceId, t.productId, t.count, qcDispatcher);
    stocked.push(...results);
  }

  const produced = stocked.filter((s) => s.ok).length;
  return { workspaceId, stocked, produced, failed: stocked.length - produced };
}
