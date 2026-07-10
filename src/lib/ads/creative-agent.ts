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
import { selectAngles, buildCreativeBrief, type ScoredAngle } from "@/lib/ads/creative-brief";
import { generateCreative } from "@/lib/ads/creative-generate";
import { qaCreative } from "@/lib/ads/creative-qa";
import { uploadBuffer, signedUrl } from "@/lib/ad-storage";
import { listReadyToTest } from "@/lib/ads/ready-to-test";

type Admin = ReturnType<typeof createAdminClient>;

/** Default target depth per product for the ready-to-test bin — kept small; the media buyer tests a
 *  handful at a time and creatives fatigue, so we top up rather than stockpile. */
export const DEFAULT_BIN_FLOOR = 4;
/** Cap how many creatives one job produces, so a deep deficit can't run away on image-gen cost. */
const MAX_PER_JOB = 4;
/** Regenerate-on-QA-fail attempts per creative before giving up on that angle. */
const MAX_QA_ATTEMPTS = 2;

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
      meta_headline: metaCopy.headline.slice(0, 40),
      meta_primary_text: metaCopy.primaryText.slice(0, 125),
      meta_description: metaCopy.description.slice(0, 30),
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
 *  angles. Skips angles already represented by an existing campaign so we add variety, not dupes. */
async function stockProduct(admin: Admin, workspaceId: string, productId: string, count: number): Promise<StockedCreative[]> {
  const out: StockedCreative[] = [];
  const pi = await getProductIntelligence(admin, workspaceId, productId);
  const product = pi.product as { title?: string; handle?: string } | null;
  if (!product?.handle) return [{ productId, angleHook: "", campaignId: null, ok: false, reason: "product_missing_handle" }];
  const productTitle = product.title ?? "Product";

  const stories = await loadTransformationStories(admin, workspaceId, productId);
  const ranked = selectAngles(pi, stories);

  // Skip angle hooks already in the bin for this product (variety, not dupes).
  const { data: existingCampaigns } = await admin
    .from("ad_campaigns")
    .select("product_ad_angles(hook_one_liner)")
    .eq("workspace_id", workspaceId).eq("product_id", productId);
  const usedHooks = new Set(
    ((existingCampaigns ?? []) as Array<{ product_ad_angles?: { hook_one_liner?: string | null } | null }>)
      .map((c) => (c.product_ad_angles?.hook_one_liner ?? "").toLowerCase().slice(0, 60))
      .filter(Boolean),
  );
  const fresh = ranked.filter((a) => !usedHooks.has(a.hook.toLowerCase().slice(0, 60)));
  const pool = fresh.length ? fresh : ranked; // if everything's been used, allow refresh from the top

  for (const angle of pool.slice(0, count)) {
    let landed = false;
    let lastIssues: string[] = [];
    for (let attempt = 0; attempt < MAX_QA_ATTEMPTS && !landed; attempt++) {
      try {
        const brief = await buildCreativeBrief(pi, angle, stories);
        const gen = await generateCreative(workspaceId, brief);
        const verdict = await qaCreative(workspaceId, { buffer: gen.buffer, expectedCopy: gen.expectedCopy, hasTransformation: !!brief.transformation });
        if (!verdict.pass) { lastIssues = verdict.issues; continue; }
        const metaCopy = {
          headline: (brief.offer?.headline ?? angle.leadBenefit).slice(0, 40),
          primaryText: `${angle.hook} ${brief.supportingBenefits[0] ?? ""}`.trim(),
          description: (brief.offer?.perServing ?? brief.offer?.headline ?? "").slice(0, 30),
        };
        const campaignId = await insertReadyCreative(admin, workspaceId, productId, product.handle, productTitle, angle, metaCopy, { buffer: gen.buffer, mimeType: gen.mimeType });
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
 */
export async function runAdCreativeLoop(
  admin: Admin,
  opts: { workspaceId: string; productId?: string; count?: number; binFloor?: number },
): Promise<AdCreativeRunResult> {
  const { workspaceId } = opts;
  const binFloor = opts.binFloor ?? DEFAULT_BIN_FLOOR;
  const stocked: StockedCreative[] = [];

  const targets: Array<{ productId: string; count: number }> = [];
  if (opts.productId) {
    targets.push({ productId: opts.productId, count: Math.min(opts.count ?? binFloor, MAX_PER_JOB) });
  } else {
    // Every product that HAS ad intelligence (an angle row), topped up to the floor.
    const { data: angleProducts } = await admin
      .from("product_ad_angles").select("product_id").eq("workspace_id", workspaceId);
    const productIds = [...new Set(((angleProducts ?? []) as Array<{ product_id: string }>).map((r) => r.product_id).filter(Boolean))];
    for (const productId of productIds) {
      const depth = await currentBinDepth(admin, workspaceId, productId);
      const deficit = binFloor - depth;
      if (deficit > 0) targets.push({ productId, count: Math.min(deficit, MAX_PER_JOB) });
    }
  }

  for (const t of targets) {
    const results = await stockProduct(admin, workspaceId, t.productId, t.count);
    stocked.push(...results);
  }

  const produced = stocked.filter((s) => s.ok).length;
  return { workspaceId, stocked, produced, failed: stocked.length - produced };
}
