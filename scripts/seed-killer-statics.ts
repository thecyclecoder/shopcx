/**
 * Seed the proven Amazing Coffee "killer statics" as publish-ready campaigns.
 *
 * For each cold-50+ archetype this:
 *   1. ensures a product_ad_angle anchored to a CORE desire (weight / aging /
 *      best-self / social) — feeds the copy + hero selection,
 *   2. creates an ad_campaigns row (angle_id + landing_url from the archetype→
 *      lander map),
 *   3. fires ad-tool/static-requested → renders 4:5 + 9:16 onto ad_videos
 *      (media_kind='static'), and
 *   4. pre-generates Meta copy onto the angle's meta_* fields.
 * End state: each archetype is a campaign with ready statics + a landing URL +
 * copy, so the operator only picks page/account/adset and clicks Publish.
 *
 *   npx tsx scripts/seed-killer-statics.ts            # Amazing Coffee defaults
 *   WS=… PID=… npx tsx scripts/seed-killer-statics.ts # other product
 *
 * Idempotent: re-running reuses a campaign with the same name and won't duplicate.
 * Operational (creates rows, sends events, calls Opus) — run intentionally.
 */
// MUST be first: populates process.env from .env.local before the Inngest client
// (and other lib clients) evaluate — they capture env at import time, so the
// inline env-load that used to live here ran too late (ESM hoists imports above
// top-level code) and INNGEST_EVENT_KEY was missing → renders weren't queued.
import "./load-env";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { KILLER_ARCHETYPES, ARCHETYPE_LANDER, type KillerArchetype } from "@/lib/ad-statics";
import { generateMetaCopy } from "@/lib/ad-meta-copy";
import { generateAdvertorialPagesForCampaign } from "@/lib/advertorial-pages";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PID = process.env.PID || "ea433e56-0aa4-4b46-9107-feb11f77f533";
const STOREFRONT_OVERRIDE = process.env.STOREFRONT_BASE || "";

// Angle per archetype — anchored to the product's core desires (NEVER functional energy).
const ANGLE_BY_ARCHETYPE: Record<KillerArchetype, { hook_slug: string; lf8_slot: number; lead_benefit_anchor: string; hook_one_liner: string; pain_now: string; desired_outcome: string }> = {
  advertorial: { hook_slug: "callout", lf8_slot: 6, lead_benefit_anchor: "healthy weight loss", hook_one_liner: "The morning coffee helping people over 50 finally lose the weight", pain_now: "the weight stops responding to everything that used to work", desired_outcome: "lose the weight that won't budge and feel like yourself again" },
  testimonial: { hook_slug: "results_first", lf8_slot: 6, lead_benefit_anchor: "healthy weight loss", hook_one_liner: "Real customers are losing weight on their morning coffee", pain_now: "tried everything and nothing sticks", desired_outcome: "lose weight and feel confident again" },
  authority: { hook_slug: "secret_reveal", lf8_slot: 1, lead_benefit_anchor: "antioxidants that fight aging", hook_one_liner: "What a dietitian says about the coffee that fights aging", pain_now: "aging shows up first in the mirror", desired_outcome: "fight visible aging and look younger" },
  big_claim: { hook_slug: "contrarian", lf8_slot: 1, lead_benefit_anchor: "antioxidants that fight aging", hook_one_liner: "Your coffee is aging you — this one fights back", pain_now: "ordinary coffee adds to oxidative stress", desired_outcome: "firmer, younger-looking skin" },
  before_after: { hook_slug: "results_first", lf8_slot: 8, lead_benefit_anchor: "healthy weight loss", hook_one_liner: "Lighter, brighter — and getting compliments again", pain_now: "feeling invisible and not like yourself", desired_outcome: "be noticed and complimented again" },
  ingredient_breakdown: { hook_slug: "secret_reveal", lf8_slot: 6, lead_benefit_anchor: "healthy weight loss", hook_one_liner: "The longer you drink it, the more it works", pain_now: "ordinary coffee does nothing for the weight or the aging", desired_outcome: "lose weight and fight aging from one morning cup" },
};

async function ensureAngle(admin: ReturnType<typeof createAdminClient>, archetype: KillerArchetype): Promise<string | null> {
  const a = ANGLE_BY_ARCHETYPE[archetype];
  const { data: existing } = await admin
    .from("product_ad_angles")
    .select("id")
    .eq("workspace_id", WS).eq("product_id", PID).eq("hook_slug", a.hook_slug).eq("is_active", true)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existing?.id) return existing.id;
  const { data, error } = await admin
    .from("product_ad_angles")
    .insert({ workspace_id: WS, product_id: PID, hook_slug: a.hook_slug, lf8_slot: a.lf8_slot, lead_benefit_anchor: a.lead_benefit_anchor, hook_one_liner: a.hook_one_liner, pain_now: a.pain_now, desired_outcome: a.desired_outcome, urgency_lever: "none", generated_by: "imported", is_active: true })
    .select("id").single();
  if (error) { console.log(`  ✗ angle ${archetype}: ${error.message}`); return null; }
  return data!.id;
}

async function ensureCampaign(admin: ReturnType<typeof createAdminClient>, archetype: KillerArchetype, angleId: string | null, landingUrl: string): Promise<string | null> {
  const name = `Static · Amazing Coffee · ${archetype}`;
  const { data: existing } = await admin
    .from("ad_campaigns").select("id").eq("workspace_id", WS).eq("product_id", PID).eq("name", name).limit(1).maybeSingle();
  if (existing?.id) {
    // keep angle + landing fresh; landing_url tolerated-missing pre-migration
    await admin.from("ad_campaigns").update({ angle_id: angleId }).eq("id", existing.id);
    await admin.from("ad_campaigns").update({ landing_url: landingUrl }).eq("id", existing.id).then(undefined, () => {});
    return existing.id;
  }
  const { data, error } = await admin
    .from("ad_campaigns")
    .insert({ workspace_id: WS, product_id: PID, name, angle_id: angleId, status: "draft" })
    .select("id").single();
  if (error) { console.log(`  ✗ campaign ${archetype}: ${error.message}`); return null; }
  // landing_url in a separate update so a pre-migration DB still seeds the campaign.
  await admin.from("ad_campaigns").update({ landing_url: landingUrl }).eq("id", data!.id).then(undefined, () => {});
  return data!.id;
}

async function main() {
  const admin = createAdminClient();
  const { data: product } = await admin.from("products").select("title, handle").eq("id", PID).maybeSingle();
  const handle = (product as any)?.handle as string | undefined;
  // Internally-created landers live on the IN-HOUSE storefront domain
  // (shop.superfoodscompany.com), NOT the Shopify store (superfoodscompany.com/products).
  const { data: ws } = await admin.from("workspaces").select("storefront_domain").eq("id", WS).maybeSingle();
  const base = STOREFRONT_OVERRIDE || ((ws as any)?.storefront_domain ? `https://${(ws as any).storefront_domain}` : "https://shop.superfoodscompany.com");
  const pdp = handle ? `${base}/${handle}` : base;
  // Archetype → landing page (ad_creative_rules): testimonial/authority/big_claim
  // → PDP; advertorial → advertorial lander; before_after → before/after lander.
  // For the two lander archetypes we generate the lander page here (idempotent
  // upsert) to learn its real slug, then point landing_url at the matching variant.
  const resolveLanding = async (archetype: KillerArchetype, campaignId: string): Promise<string> => {
    const kind = ARCHETYPE_LANDER[archetype];
    if (kind === "pdp") return pdp;
    const variant = kind === "before_after" ? "beforeafter" : kind === "reasons" ? "reasons" : "advertorial";
    try {
      const res = await generateAdvertorialPagesForCampaign(WS, campaignId);
      const lander = res.landers.find((l) => l.variant === variant);
      if (lander) return `${pdp}${lander.url_path}`;
      console.log(`  · no ${variant} lander generated (${res.reason || "?"}) → PDP`);
    } catch (e) { console.log(`  · lander gen skipped: ${e instanceof Error ? e.message : e}`); }
    return pdp;
  };

  console.log(`Seeding killer statics for "${product?.title || PID}" → ${pdp}\n`);
  let renderQueueFailed = false;
  for (const archetype of KILLER_ARCHETYPES) {
    console.log(`• ${archetype}`);
    const angleId = await ensureAngle(admin, archetype);
    const campaignId = await ensureCampaign(admin, archetype, angleId, pdp);
    if (!campaignId) continue;
    // Fire the render. Needs INNGEST_EVENT_KEY (set locally, or trigger from the
    // deployed dashboard which has it). Don't abort the whole seed if it's missing —
    // the campaign/angle/landing/copy are still seeded and renders can fire later.
    try {
      await inngest.send({ name: "ad-tool/static-requested", data: { workspace_id: WS, campaign_id: campaignId, archetype } });
      console.log(`  ✓ campaign ${campaignId} — render queued (4:5 + 9:16)`);
    } catch (e) {
      renderQueueFailed = true;
      console.log(`  · campaign ${campaignId} — render NOT queued (${e instanceof Error ? e.message.split("\n")[0] : e})`);
    }
    const landing = await resolveLanding(archetype, campaignId);
    if (landing !== pdp) {
      await admin.from("ad_campaigns").update({ landing_url: landing }).eq("id", campaignId).then(undefined, () => {});
      console.log(`  ✓ lander → ${landing}`);
    }
    try {
      const copy = await generateMetaCopy(WS, campaignId);
      if (copy && angleId) {
        await admin.from("product_ad_angles").update({
          meta_headline: (copy.headlines[0] || "").slice(0, 40),
          meta_primary_text: (copy.primaryTexts[0] || "").slice(0, 125),
          meta_description: (copy.description || "").slice(0, 30),
        }).eq("id", angleId);
        console.log(`  ✓ meta copy pre-generated`);
      }
    } catch (e) { console.log(`  · copy skipped: ${e instanceof Error ? e.message : e}`); }
  }
  if (renderQueueFailed) {
    console.log(`\n⚠ Some renders weren't queued (no INNGEST_EVENT_KEY locally). Campaigns,`);
    console.log(`  angle metadata, landing URLs and Meta copy ARE seeded. To render the statics:`);
    console.log(`  • add INNGEST_EVENT_KEY to .env.local and re-run this seed, OR`);
    console.log(`  • open each campaign in the dashboard and click "Generate" (the app has the key).`);
  } else {
    console.log(`\nDone. Statics render in the background; open each campaign and click Publish.`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
