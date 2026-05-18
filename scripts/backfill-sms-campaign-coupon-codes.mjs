/**
 * Backfill sms_campaigns.coupon_code by parsing /discount/CODE out of
 * shortlink_target_url. Then report which past orders the coupon-fallback
 * attribution would now recapture (orders that used the coupon but had no
 * shopcx_sms UTM).
 */
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
const APPLY = process.argv.includes("--apply");

// Matches /discount/CODE (encoded or not), captures CODE up to ? / # or end.
const DISCOUNT_RE = /\/discount\/([^/?#]+)/i;

function extractCoupon(url) {
  if (!url) return null;
  const m = DISCOUNT_RE.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

const SUB_SOURCES = new Set(["subscription_contract", "subscription_contract_checkout_one"]);
function isSub(o) { return SUB_SOURCES.has(o.source_name) || !!o.subscription_id; }

const { data: campaigns, error } = await sb.from("sms_campaigns")
  .select("id, name, coupon_code, shortlink_target_url, send_date, status, created_at")
  .eq("workspace_id", W);
if (error) { console.error(error); process.exit(1); }

let need = 0, skipped = 0, updated = 0;
const updates = [];
for (const c of campaigns || []) {
  const parsed = extractCoupon(c.shortlink_target_url);
  if (!parsed) { skipped++; continue; }
  if (c.coupon_code && c.coupon_code.toUpperCase() === parsed.toUpperCase()) { skipped++; continue; }
  need++;
  updates.push({ id: c.id, name: c.name, send_date: c.send_date, old: c.coupon_code, new: parsed });
}

console.log(`Total campaigns: ${campaigns?.length || 0}`);
console.log(`Already in sync / no shortlink: ${skipped}`);
console.log(`Will update: ${need}`);
console.log();
console.log("=== Planned updates ===");
for (const u of updates) {
  console.log(`  ${u.send_date || "—"} | ${u.name.slice(0, 50).padEnd(50)} | ${u.old || "(null)"} → ${u.new}`);
}

if (APPLY && updates.length) {
  console.log("\nApplying...");
  for (const u of updates) {
    const { error: e } = await sb.from("sms_campaigns")
      .update({ coupon_code: u.new, updated_at: new Date().toISOString() })
      .eq("id", u.id);
    if (e) { console.error(`Failed ${u.id}: ${e.message}`); continue; }
    updated++;
  }
  console.log(`Updated ${updated}/${updates.length}.`);
} else if (updates.length) {
  console.log("\n(Dry run — pass --apply to write.)");
}

// ── Recapture report ─────────────────────────────────────────────
// For every campaign with a coupon, count orders that used it AND
// (a) cleanly attribute via UTM, (b) would only be captured by the
// coupon fallback (no UTM or UTM to a different source).
console.log("\n=== Recapture impact (coupon-fallback vs UTM-only attribution) ===");
const liveCampaigns = (campaigns || []).map(c => ({ ...c, coupon_code: c.coupon_code || extractCoupon(c.shortlink_target_url) || null })).filter(c => c.coupon_code);

const { data: orders } = await sb.from("orders")
  .select("order_number, total_cents, source_name, subscription_id, discount_codes, attributed_utm_source, attributed_utm_campaign, created_at")
  .eq("workspace_id", W)
  .gte("created_at", "2026-04-01T00:00:00Z")  // window covers all live campaigns
  .order("created_at", { ascending: false })
  .limit(20000);

const nonSubOrders = (orders || []).filter(o => !isSub(o));

let totalUtm = 0, utmRev = 0;
let totalRecaptured = 0, recapturedRev = 0;
const perCampaign = new Map();

for (const c of liveCampaigns) {
  let utmCount = 0, utmR = 0, recapCount = 0, recapR = 0;
  for (const o of nonSubOrders) {
    const codes = (o.discount_codes || []).map(x => (typeof x === "string" ? x : x?.code || "")).join("|").toUpperCase();
    const utmMatch = o.attributed_utm_campaign === c.id;
    const couponMatch = codes.includes(c.coupon_code.toUpperCase());
    if (utmMatch) { utmCount++; utmR += o.total_cents || 0; }
    else if (couponMatch) { recapCount++; recapR += o.total_cents || 0; }
  }
  if (utmCount + recapCount > 0) perCampaign.set(c.id, { name: c.name, code: c.coupon_code, send_date: c.send_date, utmCount, utmR, recapCount, recapR });
  totalUtm += utmCount; utmRev += utmR;
  totalRecaptured += recapCount; recapturedRev += recapR;
}

console.log(`Campaigns with parsed coupon codes: ${liveCampaigns.length}`);
console.log(`UTM-attributed non-sub orders: ${totalUtm} ($${(utmRev / 100).toFixed(2)})`);
console.log(`Would-be-recaptured by coupon-fallback: ${totalRecaptured} ($${(recapturedRev / 100).toFixed(2)})`);
const totalCombined = totalUtm + totalRecaptured;
const totalRev = utmRev + recapturedRev;
console.log(`Combined (UTM OR coupon): ${totalCombined} orders ($${(totalRev / 100).toFixed(2)})`);
if (totalRev > 0) console.log(`Recapture share of revenue: ${((recapturedRev / totalRev) * 100).toFixed(1)}%`);

console.log("\n=== Per-campaign breakdown ===");
const rows = [...perCampaign.values()].sort((a, b) => (a.send_date || "").localeCompare(b.send_date || ""));
for (const r of rows) {
  console.log(`  ${r.send_date || "—"} | ${r.code.padEnd(10)} | ${r.name.slice(0, 40).padEnd(40)} | UTM ${r.utmCount} ($${(r.utmR / 100).toFixed(0)}) + recap ${r.recapCount} ($${(r.recapR / 100).toFixed(0)})`);
}
