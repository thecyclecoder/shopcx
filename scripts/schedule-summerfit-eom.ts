/**
 * End-of-month VIP/SUMMERFIT sale — 4 campaigns, 5/31 at 9:30 AM local.
 *
 *   Tier 1 segments by likelihood-to-purchase: engaged, lapsed, just_ordered, cycle_hitter
 *   Exclude: anyone who already bought via an MDW campaign (don't double-discount)
 *
 * Steps:
 *   1. Identify MDW buyers (customer_ids on non-sub orders with utm_campaign
 *      matching the last month's MDW campaigns) and tag them with a
 *      `mdw_2026_buyer` segment so the campaign builder's excluded_segments
 *      filter can drop them.
 *   2. Insert 4 sms_campaigns rows, one per segment, all scheduled for
 *      2026-05-31 9:30 local (fallback 11:00 Central).
 *   3. Fire `marketing/text-campaign.scheduled` event for each so the
 *      audience-resolve + recipient-enqueue Inngest function runs.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
import { Inngest } from "inngest";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const inngest = new Inngest({ id: "shopcx", eventKey: process.env.INNGEST_EVENT_KEY! });

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TIER_1_SEGMENTS = ["engaged", "lapsed", "just_ordered", "cycle_hitter", "deep_lapsed"];
const MDW_BUYER_SEGMENT = "mdw_2026_buyer";
const SEND_DATE = "2026-05-31";
const MESSAGE_BODY = "Get summer-ready with our natural superfoods - 1 day only sale.\n\nGet Coupon: {shortlink}\n\nOnly 43 coupons left!";
const COUPON_CODE = "SUMMERFIT";
const SHORTLINK_URL = "https://superfoodscompany.com/discount/SUMMERFIT?redirect=/collections/summer-ready";

async function main() {
  // ── 1. Find MDW buyers ─────────────────────────────────────────
  const { data: mdwCampaigns } = await admin
    .from("sms_campaigns")
    .select("id, name")
    .eq("workspace_id", WORKSPACE_ID)
    .ilike("name", "%MDW%");
  const mdwIds = (mdwCampaigns || []).map(c => c.id);
  console.log(`Found ${mdwIds.length} MDW campaigns:`);
  for (const c of mdwCampaigns || []) console.log(`  ${c.name}`);

  const { data: mdwOrders } = await admin
    .from("orders")
    .select("customer_id, source_name, subscription_id")
    .eq("workspace_id", WORKSPACE_ID)
    .in("attributed_utm_campaign", mdwIds);
  const SUB_SOURCES = new Set(["subscription_contract", "subscription_contract_checkout_one"]);
  const mdwBuyerIds = new Set<string>();
  for (const o of (mdwOrders || []) as Array<{ customer_id: string | null; source_name: string | null; subscription_id: string | null }>) {
    if (SUB_SOURCES.has(o.source_name || "") || o.subscription_id) continue;
    if (o.customer_id) mdwBuyerIds.add(o.customer_id);
  }
  console.log(`\n${mdwBuyerIds.size} MDW non-sub buyers to exclude`);

  // ── 2. Tag those customers with mdw_2026_buyer segment ─────────
  if (mdwBuyerIds.size > 0) {
    // Pull current segments per customer and add the tag (idempotent)
    const ids = [...mdwBuyerIds];
    const batchSize = 500;
    let tagged = 0;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const { data: rows } = await admin.from("customers").select("id, segments").in("id", batch);
      for (const r of rows || []) {
        const segs = (r.segments as string[] | null) || [];
        if (segs.includes(MDW_BUYER_SEGMENT)) continue;
        await admin.from("customers").update({ segments: [...segs, MDW_BUYER_SEGMENT] }).eq("id", r.id);
        tagged++;
      }
    }
    console.log(`Tagged ${tagged} customers with "${MDW_BUYER_SEGMENT}"`);
  }

  // ── 3. Create 4 campaigns + trigger audience resolve ────────────
  for (const segment of TIER_1_SEGMENTS) {
    const name = `SUMMERFIT - ${segment}`;
    const { data: existing } = await admin
      .from("sms_campaigns")
      .select("id, status")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("name", name)
      .maybeSingle();
    if (existing) {
      console.log(`⚠️  ${name} already exists (id=${existing.id}, status=${existing.status}) — skipping`);
      continue;
    }

    const { data: created, error } = await admin
      .from("sms_campaigns")
      .insert({
        workspace_id: WORKSPACE_ID,
        name,
        message_body: MESSAGE_BODY,
        send_date: SEND_DATE,
        target_local_hour: 9,
        target_local_minute: 30,
        fallback_timezone: "America/Chicago",
        fallback_target_local_hour: 11,
        fallback_target_local_minute: 0,
        included_segments: [segment],
        excluded_segments: [MDW_BUYER_SEGMENT],
        coupon_code: COUPON_CODE,
        coupon_enabled: false,  // coupon is pre-existing, we're not auto-generating
        shortlink_target_url: SHORTLINK_URL,
        status: "draft",
      })
      .select("id")
      .single();
    if (error) { console.log(`✗ ${name} failed: ${error.message}`); continue; }
    console.log(`✓ Created ${name} (id=${created.id})`);

    // Fire the Inngest event that resolves audience + enqueues recipients
    await inngest.send({
      name: "marketing/text-campaign.scheduled",
      data: { campaign_id: created.id },
    });
    console.log(`  → audience-resolve queued`);
  }

  console.log("\nMessage body preview (substituted):");
  console.log(`  ${MESSAGE_BODY.replace("{coupon}", COUPON_CODE).replace("{shortlink}", "https://superfd.co/XXXXXX/YYYY")}`);
  const sample = MESSAGE_BODY.replace("{coupon}", COUPON_CODE).replace("{shortlink}", "https://superfd.co/XXXXXX/YYYY");
  console.log(`  Character count: ${sample.length} (limit 160)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
