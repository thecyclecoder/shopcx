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
import { selectAngles, buildCreativeBrief, type ScoredAngle, type CreativeBrief } from "@/lib/ads/creative-brief";
import { hasColdOfferLeak } from "@/lib/ads/lf8";
import { loadCreativeLearning, nextTreatmentFor, recordCombinationGenerated, angleKey } from "@/lib/ads/creative-learning";
import { getProvenCompetitorAngles } from "@/lib/ads/creative-sourcing";
import { generateCreative } from "@/lib/ads/creative-generate";
import { qaCreative, qaCreativeViaBoxSession, type QcSessionDispatcher } from "@/lib/ads/creative-qa";
import { uploadBuffer, signedUrl } from "@/lib/ad-storage";
import { listReadyToTest } from "@/lib/ads/ready-to-test";
import { isAdvertisedProduct, listAdvertisedProductIds } from "@/lib/advertised-products";
import { META_CAPS } from "@/lib/ad-tool-config";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";
import { recordDirectorActivity } from "@/lib/director-activity";
import {
  buildMetaCopyPack,
  placementPackPlan,
  planCreativePackInserts,
  type MetaCopyPack,
  type RenderedPlacement,
} from "@/lib/ads/creative-pack";

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

/** Angle-before-ready invariant (dahlia-creative-requires-angle-before-ready): a bin creative can only
 *  land at `status='ready'` when it carries an `angle_id`. A null angle means no ad-copy source, so the
 *  media buyer's replenish path skips it ([[media-buyer/agent]]:1478 — "campaign has no angle_id — no
 *  ad-copy source; skipped to avoid a malformed Meta creative"), which silently inflates bin depth with
 *  un-replenishable rows. Expressed once, greppable, and used at every ready-insert site. */
export function readyStatusForAngle(angleId: string | null | undefined): "ready" | "draft" {
  return angleId ? "ready" : "draft";
}

/** True iff the brief carries a FAITHFUL product image — the isolated packshot Dahlia's composition
 *  transfer needs to "swap in OUR product" from the competitor's winning layout. Without one, the
 *  generator has only the competitor's graphic to work from and hallucinates a plausible-looking
 *  pack from the brand name alone (a pink pouch in one draft, a red box in another — the exact
 *  2026-07-14 Ashwavana Zen Relax fabrication that motivated this spec). A `role:'packshot'` ref
 *  is added by [[creative-brief]] `buildCreativeBrief` only when `pi.media.isolatedPackshots[0]`
 *  exists (i.e. `product_variants.isolated_image_url` was backfilled for the product). */
export function briefHasFaithfulPackshot(brief: Pick<CreativeBrief, "imageRefs">): boolean {
  return brief.imageRefs.some(
    (r) => r.role === "packshot" && typeof r.url === "string" && /^(https?:|data:)/.test(r.url),
  );
}

/** Discriminated outcome of `planCompositionTransfer` — pure, so a unit test can pin every branch
 *  without spinning up Supabase / Gemini. `skip` is the packshot-missing branch (the invariant this
 *  spec adds); `run` carries whether the actual generateCreative call should be a composition
 *  transfer (competitor angle + refUrl + packshot present) or a plain generate. */
export type CompositionTransferPlan =
  | { kind: "skip"; reason: "packshot_missing" }
  | { kind: "run"; useCompositionTransfer: boolean; designReferenceUrl: string | undefined };

/**
 * planCompositionTransfer — decide whether this (angle, brief) pair may run composition transfer.
 *
 * The invariant this enforces (spec `ad-creative-requires-real-packshot-never-invent-packaging`
 * Phase 1): a competitor-angle generation may NOT use composition transfer unless the brief carries
 * a faithful packshot ref. Composition transfer's prompt tells Nano Banana to "swap in OUR product
 * from the other provided images" — with no such image the model fabricates one from the brand
 * name alone. So:
 *   • own-brand angle (source !== 'competitor') → `run { useCompositionTransfer: false }`
 *   • competitor angle without a refUrl → `run { useCompositionTransfer: false }` (nothing to
 *     composition-transfer against; a plain generate is fine).
 *   • competitor angle + refUrl but NO packshot ref in the brief → `skip { packshot_missing }`.
 *     The caller MUST escalate that the product needs an isolated packshot uploaded to
 *     `product_variants.isolated_image_url`, then move on to the next angle without generating.
 *   • competitor angle + refUrl + packshot ref → `run { useCompositionTransfer: true }`.
 */
export function planCompositionTransfer(
  angle: Pick<ScoredAngle, "source" | "raw">,
  brief: Pick<CreativeBrief, "imageRefs">,
): CompositionTransferPlan {
  const isCompetitor = angle.source === "competitor";
  const rawImageUrl = angle.raw?.imageUrl;
  const refUrl = isCompetitor && typeof rawImageUrl === "string" && rawImageUrl.length > 0 ? rawImageUrl : undefined;
  if (!isCompetitor || !refUrl) return { kind: "run", useCompositionTransfer: false, designReferenceUrl: refUrl };
  if (!briefHasFaithfulPackshot(brief)) return { kind: "skip", reason: "packshot_missing" };
  return { kind: "run", useCompositionTransfer: true, designReferenceUrl: refUrl };
}

/** How many ready-to-test creatives a product currently has in the bin. */
async function currentBinDepth(admin: Admin, workspaceId: string, productId: string): Promise<number> {
  const { readyToTest } = await listReadyToTest(admin, { workspaceId });
  if (!readyToTest.length) return 0;
  const ids = readyToTest.map((r) => r.ad_campaign_id);
  const { data } = await admin.from("ad_campaigns").select("id").eq("workspace_id", workspaceId).eq("product_id", productId).in("id", ids);
  return (data ?? []).length;
}

/** Discriminated result for `insertReadyCreative` — 'ok' carries the new campaign id, 'skip'
 *  names the deterministic cold-offer-gate refusal (author session catches it and revises the copy),
 *  'failed' is the insert-missed case (angle-insert missed / RLS deny / cErr on the campaign insert). */
export type InsertReadyCreativeResult =
  | { kind: "ok"; campaignId: string }
  | { kind: "skip"; reason: "cold_offer_leak" }
  | { kind: "failed" };

/** Insert one finished creative PACK into the ready-to-test bin. A pack = one angle row carrying
 *  the 4-headline + 4-primary-text copy variations (persisted on the angle's scalar columns AND on
 *  its `metadata.copy_pack` JSONB for the sibling publish path to read) + one campaign row + THREE
 *  placement statics (`feed_4x5` canonical + `stories_9x16` + `right_column_1x1` siblings pointing
 *  at the canonical via `format_variant_of_id`). The 3 statics carry the SAME core conversion
 *  psychology by construction — they're rendered from ONE brief; only aspect/crop varies.
 *  (dahlia-produces-3-placement-multi-copy-creative-pack Phase 2.)
 *
 *  DETERMINISTIC COLD-OFFER GATE (dahlia-audience-temperature-marking-and-cold-offer-gate Phase 2):
 *  if the caller marks the pack 'cold' audience AND ANY of the pack's rotated copy trips
 *  [[../ads/lf8]] `hasColdOfferLeak`, refuse the insert before any DB write (returns `skip`). The
 *  MSRP + packaging rails remain their own separate gates; a warm/hot/null-temperature pack bypasses
 *  this gate. The temperature is written to `ad_campaigns.audience_temperature` so the row is
 *  self-describing (M1 keystone author session sets 'cold'/'warm'/'hot'; the deterministic
 *  buildMetaCopyPack path leaves the option undefined → NULL, gate skips).
 *
 *  Returns a discriminated result: `ok` with the campaign id, `skip` on a cold-offer refusal, or
 *  `failed` when the angle/campaign insert missed. */
async function insertReadyCreative(
  admin: Admin,
  workspaceId: string,
  productId: string,
  productHandle: string,
  productTitle: string,
  angle: ScoredAngle,
  copyPack: MetaCopyPack,
  renders: { canonical: RenderedPlacement; siblings: RenderedPlacement[] },
  opts?: { audienceTemperature?: "cold" | "warm" | "hot" | null },
): Promise<InsertReadyCreativeResult> {
  // Phase-2 cold-offer gate — fires BEFORE any DB write so the refusal is atomic and cheap. NULL /
  // warm / hot pass through untouched (the deterministic buildMetaCopyPack path is temperature-
  // agnostic and always leaves audience_temperature undefined here). Check ALL rotated pack copy
  // (headlines + primary texts joined) so the pack is refused if ANY variant leaks a cold offer.
  // See [[../ads/lf8]] `hasColdOfferLeak`.
  const audienceTemperature: "cold" | "warm" | "hot" | null = opts?.audienceTemperature ?? null;
  if (
    audienceTemperature === "cold" &&
    hasColdOfferLeak({
      headline: copyPack.headlines.join(" "),
      primaryText: copyPack.primaryTexts.join(" "),
      description: copyPack.description,
    })
  ) {
    return { kind: "skip", reason: "cold_offer_leak" };
  }

  const { data: angleRow } = await admin
    .from("product_ad_angles")
    .insert({
      workspace_id: workspaceId, product_id: productId,
      hook_slug: "results_first", lf8_slot: 8,
      lead_benefit_anchor: angle.leadBenefit.slice(0, 120),
      hook_one_liner: angle.hook.slice(0, 120),
      urgency_lever: "none", generated_by: "ad-creative-agent", is_active: true,
      meta_headline: copyPack.headlines[0].slice(0, META_CAPS.headline),
      meta_primary_text: copyPack.primaryTexts[0].slice(0, META_CAPS.primary_text),
      meta_description: copyPack.description.slice(0, META_CAPS.description),
      metadata: { copy_pack: copyPack },
    })
    .select("id").single();

  const name = `Dahlia · ${productTitle} · ${angle.source}`;
  const angleId = (angleRow as { id?: string } | null)?.id ?? null;
  const status = readyStatusForAngle(angleId);
  if (!angleId) {
    // dahlia_creative_missing_angle — the angle-row insert missed (a race, RLS deny, or a schema drift),
    // so the creative can't be replenished (no ad-copy source). Hold the row at 'draft' rather than
    // minting a phantom 'ready' that inflates bin depth. Named for grep + future director_activity roll-up.
    console.warn("dahlia_creative_missing_angle", { workspaceId, productId, productTitle, hook: angle.hook.slice(0, 80) });
  }
  const { data: campaign, error: cErr } = await admin
    .from("ad_campaigns")
    .insert({ workspace_id: workspaceId, product_id: productId, name, angle_id: angleId, status, audience_temperature: audienceTemperature })
    .select("id").single();
  if (cErr || !campaign) return { kind: "failed" };
  const campaignId = (campaign as { id: string }).id;

  // Pure planner emits the exact write bodies for the pack's 3 ad_videos rows (canonical +
  // siblings). Throws when the pack shape is malformed — Phase 3's `isCreativePackComplete`
  // re-checks persisted rows; this catches an authoring-time regression BEFORE we write.
  const plan = planCreativePackInserts({
    workspaceId,
    campaignId,
    canonicalRender: renders.canonical,
    siblingRenders: renders.siblings,
    copyPack,
    archetype: "before_after",
    generatedBy: "ad-creative-agent",
  });

  // Canonical (feed_4x5) — insert row, upload buffer, sign URL, flip to ready.
  const canonicalId = await insertOnePlacementRender(admin, workspaceId, plan.canonical, renders.canonical, null);
  if (!canonicalId) return { kind: "failed" };

  // Siblings (stories_9x16 + right_column_1x1) — point at the canonical via format_variant_of_id
  // so the same-psychology invariant is expressible in the DB: "these three rows are ONE concept."
  for (let i = 0; i < plan.siblings.length; i++) {
    await insertOnePlacementRender(admin, workspaceId, plan.siblings[i], renders.siblings[i], canonicalId);
  }

  const landingUrl = await resolveLandingUrl(admin, workspaceId, productHandle);
  if (landingUrl) await admin.from("ad_campaigns").update({ landing_url: landingUrl }).eq("id", campaignId);

  return { kind: "ok", campaignId };
}

/** Insert one placement render (canonical OR a sibling): open a pending ad_videos row, upload the
 *  buffer under `finals/{ws}/{video_id}.{ext}`, sign the URL, flip to `ready` with the storage
 *  path in `meta`. When `variantOfId` is set, the row is a sibling and its `format_variant_of_id`
 *  points at the canonical row's id (same-psychology invariant). Returns the row id. */
async function insertOnePlacementRender(
  admin: Admin,
  workspaceId: string,
  insertBody: { workspace_id: string; campaign_id: string; format: string; media_kind: string; status: string; meta: { archetype: string; generated_by: string } },
  render: RenderedPlacement,
  variantOfId: string | null,
): Promise<string | null> {
  const { data: vrow } = await admin
    .from("ad_videos")
    .insert({ ...insertBody, format_variant_of_id: variantOfId })
    .select("id").single();
  const videoId = (vrow as { id: string } | null)?.id;
  if (!videoId) return null;
  const ext = render.mimeType.includes("png") ? "png" : "jpg";
  const storagePath = `finals/${workspaceId}/${videoId}.${ext}`;
  await uploadBuffer(storagePath, render.buffer, render.mimeType);
  const url = await signedUrl(storagePath);
  await admin.from("ad_videos").update({
    static_jpg_url: url,
    status: "ready",
    meta: { ...insertBody.meta, storage_path: storagePath },
  }).eq("id", videoId);
  return videoId;
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

  // Product-scoped escalation dedupe: even though `escalateDiagnosisToCeo` dedupes on `dedupe_key`
  // across passes, we ALSO guard within a single stockProduct run so a product with N competitor
  // angles emits at most ONE escalation per invocation (never N identical warnings for the same
  // missing packshot). Set holds product ids that already escalated in THIS call.
  const escalatedForPackshot = new Set<string>();

  for (const { angle, intent, treatment } of planned) {
    const ak = angleKey(angle.hook);
    let landed = false;
    let skipped = false;
    let lastIssues: string[] = [];
    for (let attempt = 0; attempt < MAX_QA_ATTEMPTS && !landed && !skipped; attempt++) {
      try {
        const brief = await buildCreativeBrief(pi, angle, stories);
        // Composition-transfer gate (spec ad-creative-requires-real-packshot-never-invent-packaging Phase 1):
        // a competitor angle may ONLY run composition transfer when the brief has a faithful packshot.
        // Without one, the "swap in OUR product" prompt has no real pack to work from and Nano Banana
        // fabricates one from the brand name alone (a per-generation invention, not a compositing bug).
        // So skip the generation entirely for this angle, escalate ONCE per product that the packshot
        // is missing, and never silently fall through to a competitor-only image set.
        const plan = planCompositionTransfer(angle, brief);
        if (plan.kind === "skip") {
          if (!escalatedForPackshot.has(productId)) {
            escalatedForPackshot.add(productId);
            await escalatePackshotMissing(admin, workspaceId, productId, productTitle).catch((e) => {
              console.warn("dahlia_packshot_escalation_failed", { workspaceId, productId, err: e instanceof Error ? e.message : String(e) });
            });
          }
          out.push({
            productId, angleHook: angle.hook, campaignId: null, ok: false,
            reason: "packshot_missing_skipped_composition_transfer",
          });
          skipped = true; // intentional skip — not a QA/gen failure, don't retry, don't append qa_or_gen_failed
          break;
        }
        // Render the CANONICAL placement (feed 4:5) first + QA it — that's the vision-gate anchor for the
        // whole pack. If canonical passes, we render the two sibling placements (9:16 + right-column 1:1)
        // from the SAME brief so the 3 statics share their conversion psychology by construction (only
        // aspect/crop varies) — the same-psychology invariant. If ANY placement render fails, we bail on
        // this creative rather than persist a half-pack.
        // (dahlia-produces-3-placement-multi-copy-creative-pack Phase 2.)
        const packPlan = placementPackPlan();
        const gen = await generateCreative(workspaceId, brief, {
          treatment,
          designReferenceUrl: plan.designReferenceUrl,
          compositionTransfer: plan.useCompositionTransfer,
          aspectRatio: packPlan.canonical.aspectRatio,
        });
        // Phase 2 of ad-creative-requires-real-packshot-never-invent-packaging — thread the real
        // packshot URL to the QA vision compare so packagingFaithful can reject a fabricated pack
        // (an invented pack shape, a wrong-color wordmark, a competitor pack still visible). Same
        // predicate as the Phase-1 gate: a role:'packshot' ref with a fetchable URL. Undefined
        // signals to the QA to SKIP the check (own-brand no-packshot path — Phase 1 already
        // refused to composition-transfer in that case).
        const packshotRef = brief.imageRefs.find((r) => r.role === "packshot" && typeof r.url === "string" && /^(https?:|data:)/.test(r.url));
        const packshotUrl = packshotRef?.url;
        // Phase 2 of ad-creative-only-our-real-offer-discount-shown-never-a-competitors — thread
        // our REAL store offer to the QA vision compare so offerConsistent can reject a creative
        // whose rendered discount doesn't match the real offer (a "50% OFF" leaked from a
        // competitor hook when our real offer is "Up to 34% off + free shipping" — the 2026-07-14
        // Amazing Creamer regression). Undefined signals SKIP (own-brand no-offer render).
        const realOffer = brief.offer
          ? { headline: brief.offer.headline, strikethrough: brief.offer.strikethrough, perServing: brief.offer.perServing }
          : null;
        const qaInput = { buffer: gen.buffer, expectedCopy: gen.expectedCopy, hasTransformation: !!brief.transformation, packshotUrl, realOffer };
        const verdict = qcDispatcher
          ? await qaCreativeViaBoxSession(qaInput, qcDispatcher)
          : await qaCreative(workspaceId, qaInput);
        if (!verdict.pass) { lastIssues = verdict.issues; continue; }
        // Canonical passed the vision gate; render the two sibling placements from the SAME brief.
        // A sibling render failure fails the WHOLE pack (never persist a half-pack) — the retry loop
        // takes another attempt at the canonical too, so a transient sibling failure gets a full pack
        // regenerated. Aspect-ratio-only variation is why we don't re-QA each sibling (would 3× cost);
        // canonical passing signals the concept is legibly renderable.
        const siblingRenders: RenderedPlacement[] = [];
        for (const sib of packPlan.siblings) {
          const sibGen = await generateCreative(workspaceId, brief, {
            treatment,
            designReferenceUrl: plan.designReferenceUrl,
            compositionTransfer: plan.useCompositionTransfer,
            aspectRatio: sib.aspectRatio,
          });
          siblingRenders.push({ format: sib.format, buffer: sibGen.buffer, mimeType: sibGen.mimeType });
        }
        // The finished 4-headline + 4-primary-text pack — same LF8 psychology core as `buildMetaCopy`
        // (the canonical is its first entry) with 3 hook rotations across the brief's real material.
        // Persisted to `product_ad_angles.metadata.copy_pack` so Bianca's publish gate reads the full
        // pack, not just the first pair.
        const copyPack = buildMetaCopyPack(brief);
        // Deterministic buildMetaCopyPack path is temperature-agnostic — no audienceTemperature is
        // passed, so insertReadyCreative treats the pack as NULL/untagged and the Phase-2 cold-offer
        // gate skips. The M1 keystone author session (future spec) threads 'cold'/'warm'/'hot' through
        // opts.audienceTemperature; the gate then activates for cold packs automatically.
        const result = await insertReadyCreative(admin, workspaceId, productId, product.handle, productTitle, angle, copyPack, {
          canonical: { format: "feed_4x5", buffer: gen.buffer, mimeType: gen.mimeType },
          siblings: siblingRenders,
        });
        if (result.kind === "skip") {
          // cold_offer_leak — deterministic Phase-2 refusal (not a QA/gen failure). Treat like the
          // packshot skip: no retry (the copy needs a revise, not another regen), distinct reason.
          out.push({ productId, angleHook: angle.hook, campaignId: null, ok: false, reason: `cold_offer_leak` });
          skipped = true;
          break;
        }
        const campaignId = result.kind === "ok" ? result.campaignId : null;
        // Record the COMBINATION (concept × creative treatment × copy × destination) as pending — the
        // media buyer stamps its outcome later, feeding the learning flywheel.
        await recordCombinationGenerated(admin, {
          workspaceId, productId, angleKey: ak, adCampaignId: campaignId, intent,
          elements: { treatment, headline: copyPack.headlines[0], description: copyPack.primaryTexts[0], cta: "Shop now", destinationUrl: await resolveLandingUrl(admin, workspaceId, product.handle) },
        });
        out.push({ productId, angleHook: angle.hook, campaignId, ok: !!campaignId, reason: campaignId ? undefined : "bin_insert_failed", qaIssues: verdict.issues.length ? verdict.issues : undefined });
        landed = !!campaignId;
      } catch (err) {
        lastIssues = [err instanceof Error ? err.message : String(err)];
      }
    }
    if (!landed && !skipped) out.push({ productId, angleHook: angle.hook, campaignId: null, ok: false, reason: "qa_or_gen_failed", qaIssues: lastIssues });
  }
  return out;
}

/**
 * Escalate that a product needs an isolated packshot (product_variants.isolated_image_url) before
 * Dahlia can safely composition-transfer against a competitor's winning graphic — a CEO-routed
 * approval-request notification through the shared `escalateDiagnosisToCeo` helper (dedupe on
 * `dahlia-packshot-missing-<workspaceIdShort>-<productId>` so one open card per product covers
 * every subsequent pass until the packshot lands). A best-effort `director_activity` row records
 * the same event on the growth ledger so the every-3h audit can see it. Called at most ONCE per
 * stockProduct invocation via the `escalatedForPackshot` set.
 */
async function escalatePackshotMissing(
  admin: Admin,
  workspaceId: string,
  productId: string,
  productTitle: string,
): Promise<void> {
  const shortWs = workspaceId.slice(0, 8);
  const dedupeKey = `dahlia-packshot-missing-${shortWs}-${productId}`;
  const title = `Dahlia can't ad-generate: ${productTitle} needs an isolated packshot`;
  const diagnosis = [
    `Dahlia skipped a competitor-imitation ad generation for ${productTitle} because the product has no`,
    `faithful isolated packshot in product_intelligence.media.isolatedPackshots. Without one, composition`,
    `transfer's "swap in OUR product" prompt has nothing real to work from and Nano Banana fabricates a`,
    `plausible-looking pack from the brand name alone — a direct product-misrepresentation risk.`,
    ``,
    `Upload an isolated packshot to product_variants.isolated_image_url for this product; the next`,
    `ad-creative cadence will pick it up and resume composition-transfer generation for this product.`,
  ].join("\n");
  const deepLink = `/dashboard/products/${productId}`;
  const escalation = await escalateDiagnosisToCeo(admin, {
    workspaceId,
    specSlug: null,
    title,
    diagnosis,
    dedupeKey,
    deepLink,
    escalationKind: "dahlia_needs_packshot",
    metadata: {
      product_id: productId,
      product_title: productTitle,
      required_column: "product_variants.isolated_image_url",
    },
  });
  if (!escalation.emitted) return; // dedupe held OR notification insert failed — the helper already surfaced it
  // Growth-owned audit trail (distinct from the platform-owned `escalated` row the helper writes).
  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "growth",
    actionKind: "escalated_dahlia_needs_packshot",
    specSlug: null,
    reason: diagnosis,
    metadata: {
      product_id: productId,
      product_title: productTitle,
      dedupe_key: dedupeKey,
      autonomous: true,
    },
  }).catch((e) => {
    // Best-effort — a director_activity write failure must not fail the ad-creative loop.
    console.warn("dahlia_packshot_activity_write_failed", { workspaceId, productId, err: e instanceof Error ? e.message : String(e) });
  });
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
