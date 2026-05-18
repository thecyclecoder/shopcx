import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// Probe orders columns
const { data: sample } = await sb.from("orders").select("*").eq("workspace_id", W).limit(1);
console.log("orders columns:", Object.keys(sample?.[0] || {}).sort().join(", "));
console.log();

// Find the VIP-226 campaign in sms_campaigns
const { data: vipCamps } = await sb.from("sms_campaigns").select("id, name, status, coupon_code, send_date, message_body, shortlink_target_url, created_at").or("coupon_code.eq.VIP-226,message_body.ilike.%VIP-226%").eq("workspace_id", W);
console.log("=== VIP-226 campaigns ===");
for (const c of vipCamps || []) {
  console.log(`${c.id} | ${c.name} | status=${c.status} | coupon=${c.coupon_code} | send_date=${c.send_date}`);
  console.log(`  shortlink: ${c.shortlink_target_url || "(none)"}`);
}
console.log();

// Find orders that used VIP-226 — discount_codes can be in line_items or a top-level discount column.
// Let's search the order JSON
const since = "2026-05-16T00:00:00Z";
const { data: orders, error } = await sb.from("orders")
  .select("id, shopify_order_id, order_number, customer_id, created_at, total_cents, source_name, line_items, discount_codes, landing_site, referring_site, attributed_utm_source, attributed_utm_medium, attributed_utm_campaign, attributed_utm_content")
  .eq("workspace_id", W)
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(2000);
if (error) { console.error(error); process.exit(1); }

// Filter to orders with VIP-226 in discount_codes
const vipOrders = (orders || []).filter(o => {
  const codes = o.discount_codes;
  if (!codes) return false;
  const s = JSON.stringify(codes).toUpperCase();
  return s.includes("VIP-226");
});

console.log(`=== Orders since ${since} ===`);
console.log(`Total orders pulled: ${orders?.length || 0}`);
console.log(`Orders with VIP-226 code: ${vipOrders.length}`);
console.log();

// Bucket by source_name (subscription_contract = reorder)
const bySource = new Map();
for (const o of vipOrders) {
  const s = o.source_name || "(null)";
  bySource.set(s, (bySource.get(s) || 0) + 1);
}
console.log("Source breakdown:");
for (const [s, c] of bySource) console.log(`  ${s}: ${c}`);
console.log();

// Non-subscription orders only
const nonSubVip = vipOrders.filter(o => o.source_name !== "subscription_contract");
console.log(`Non-subscription VIP-226 orders: ${nonSubVip.length}`);
const totalRev = nonSubVip.reduce((sum, o) => sum + (o.total_cents || 0), 0);
console.log(`Non-subscription VIP-226 revenue: $${(totalRev / 100).toFixed(2)}`);
console.log();

// Attribution check — how many of these have UTM params?
const withUtmCampaign = nonSubVip.filter(o => o.attributed_utm_campaign);
const withUtmSource = nonSubVip.filter(o => o.attributed_utm_source);
const withLanding = nonSubVip.filter(o => o.landing_site && o.landing_site.toLowerCase().includes("utm"));
console.log(`Of ${nonSubVip.length} non-sub VIP-226 orders:`);
console.log(`  with attributed_utm_campaign: ${withUtmCampaign.length}`);
console.log(`  with attributed_utm_source: ${withUtmSource.length}`);
console.log(`  with landing_site containing UTM params: ${withLanding.length}`);
console.log();

// What are the actual UTM values we see?
console.log("Sample of UTM attribution on these orders:");
for (const o of nonSubVip.slice(0, 30)) {
  const utm = [
    o.attributed_utm_source && `src=${o.attributed_utm_source}`,
    o.attributed_utm_medium && `med=${o.attributed_utm_medium}`,
    o.attributed_utm_campaign && `camp=${o.attributed_utm_campaign}`,
    o.attributed_utm_content && `content=${o.attributed_utm_content}`,
  ].filter(Boolean).join(" ");
  const ls = (o.landing_site || "").slice(0, 80);
  console.log(`  ${o.order_number} | ${o.created_at.slice(0, 16)} | $${((o.total_cents || 0) / 100).toFixed(2)} | utm=[${utm || "—"}] | landing=${ls || "—"}`);
}
console.log();

// Also check storefront_events / klaviyo_events for the same
console.log("=== Check klaviyo_events for VIP-226 (Placed Order) ===");
const { data: kEvents, error: kErr } = await sb.from("klaviyo_events")
  .select("event_id, customer_id, properties, attributed_klaviyo_campaign_id, attributed_utm_campaign, occurred_at")
  .eq("workspace_id", W)
  .gte("occurred_at", since)
  .limit(2000);
if (kErr) console.log("klaviyo_events error:", kErr.message);
else {
  const kVip = (kEvents || []).filter(e => {
    const s = JSON.stringify(e.properties || {}).toUpperCase();
    return s.includes("VIP-226");
  });
  console.log(`klaviyo_events with VIP-226 in properties: ${kVip.length}`);
  for (const e of kVip.slice(0, 10)) {
    console.log(`  ${e.occurred_at.slice(0, 16)} | utm_camp=${e.attributed_utm_campaign || "—"} | kCamp=${e.attributed_klaviyo_campaign_id || "—"}`);
  }
}
