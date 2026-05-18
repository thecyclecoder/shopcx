/**
 * Audit Amazon 5/17 data: pull the raw SP-API report and check whether
 * the bucket classifier is misclassifying new SnS signups as recurring.
 * Reports promo_id patterns + bucket counts.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { requestReport, pollReportStatus, downloadReport } from "../src/lib/amazon/sync-orders";

async function main() {
const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const { data: conn } = await sb.from("amazon_connections").select("id, marketplace_id").eq("workspace_id", W).limit(1).single();
if (!conn) { console.error("No Amazon connection"); process.exit(1); }

console.log(`Connection ${conn.id} / marketplace ${conn.marketplace_id}`);
console.log("Requesting report for 5/17 Central → UTC window…");

// 5/17 Central = 5/17 05:00 UTC → 5/18 05:00 UTC
const reportId = await requestReport(conn.id, conn.marketplace_id, "2026-05-17T05:00:00Z", "2026-05-18T05:00:00Z");
console.log(`Report id: ${reportId}. Polling…`);

let docId: string | null = null;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 10000));
  const { status, documentId } = await pollReportStatus(conn.id, conn.marketplace_id, reportId);
  console.log(`  attempt ${i + 1}: ${status}`);
  if (status === "DONE") { docId = documentId; break; }
  if (status === "FATAL" || status === "CANCELLED") { console.error(`fatal: ${status}`); process.exit(1); }
}
if (!docId) { console.error("timed out"); process.exit(1); }

const tsv = await downloadReport(conn.id, conn.marketplace_id, docId);
const lines = tsv.split("\n");
const headers = lines[0].split("\t");
const idx = (n: string) => headers.indexOf(n);
const oidIdx = idx("amazon-order-id");
const priceIdx = idx("item-price");
const promoIdx = idx("promotion-ids");
const statusIdx = idx("order-status");
const dateIdx = idx("purchase-date");

console.log(`\nTotal lines: ${lines.length - 1}`);

const promoIdCounts = new Map<string, number>();
const buckets = new Map<string, { count: number; rev: number }>();
const orderSeenBucket = new Map<string, string>();
let bothPromos = 0;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const cols = line.split("\t");
  const status = (cols[statusIdx] || "").toLowerCase();
  if (status === "cancelled") continue;
  const promoIds = cols[promoIdx] || "";
  const price = parseFloat(cols[priceIdx]) || 0;
  const oid = cols[oidIdx];

  // Track all distinct promo IDs
  for (const p of promoIds.split(",").map(s => s.trim()).filter(Boolean)) {
    promoIdCounts.set(p, (promoIdCounts.get(p) || 0) + 1);
  }

  // Apply the CURRENT classifier
  let bucket: string;
  if (promoIds.includes("FBA Subscribe & Save Discount") || promoIds.includes("FBA Subscribe and Save Discount")) bucket = "recurring";
  else if (promoIds.includes("Subscribe and Save Promotion V2")) bucket = "sns_checkout";
  else bucket = "one_time";

  // Flag if a line has BOTH the FBA discount AND the V2 promo
  const hasFba = promoIds.includes("FBA Subscribe & Save Discount") || promoIds.includes("FBA Subscribe and Save Discount");
  const hasV2 = promoIds.includes("Subscribe and Save Promotion V2");
  if (hasFba && hasV2) bothPromos++;

  // dedupe order count per bucket
  if (!orderSeenBucket.has(oid)) {
    orderSeenBucket.set(oid, bucket);
    const cur = buckets.get(bucket) || { count: 0, rev: 0 };
    cur.count++;
    buckets.set(bucket, cur);
  }
  const cur = buckets.get(bucket)!;
  cur.rev += price;
}

console.log("\n── Bucket counts (current classifier) ──");
for (const [b, v] of buckets) console.log(`  ${b}: ${v.count} orders / $${v.rev.toFixed(2)}`);

console.log("\n── Distinct promotion-ids strings seen ──");
for (const [p, c] of [...promoIdCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`  ${c.toString().padStart(4)}× ${p}`);
}

console.log(`\nLines with BOTH FBA discount AND V2 promo: ${bothPromos}`);
console.log(`(If >0, these are likely new SnS signups misclassified as recurring.)`);

// Sum: total gross
let totalGross = 0;
let totalOrders = 0;
const seen = new Set<string>();
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim(); if (!line) continue;
  const cols = line.split("\t");
  if ((cols[statusIdx] || "").toLowerCase() === "cancelled") continue;
  const price = parseFloat(cols[priceIdx]) || 0;
  totalGross += price;
  if (!seen.has(cols[oidIdx])) { seen.add(cols[oidIdx]); totalOrders++; }
}
console.log(`\nTotal 5/17 Amazon (all buckets): ${totalOrders} orders, $${totalGross.toFixed(2)} gross`);
}
main().catch(e => { console.error(e); process.exit(1); });
