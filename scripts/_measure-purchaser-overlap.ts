/**
 * READ-ONLY measurement for the Bianca goal M2 gate: how much of what the Meta ads
 * actually convert goes to EXISTING purchasers vs NEW customers. This is the observable
 * footprint of purchaser-audience overlap (the served-but-didn't-buy overlap needs Meta's
 * audience tools + a purchase custom audience — that's the M2 build, not this pre-measure).
 *
 * Method (all from our own orders table, no Shopify first_order_at reliance):
 *   1) resolve the 6 test cohorts' test_meta_campaign_id -> internal ad_campaign ids via ad_publish_jobs
 *   2) pull Meta-attributed orders in the last N days
 *   3) an order is a NEW-customer acquisition iff it is that customer_id's earliest order across ALL time
 *   4) report repeat-share overall (all Meta-attributed) AND for the test-campaign subset
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DAYS = Number(process.env.DAYS || 60);
const META_SRC = ["facebook", "fb", "ig", "instagram", "meta", "an", "msg"];

function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

async function main() {
  const admin = createAdminClient();
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();

  // 1) test cohorts -> meta_campaign_ids -> internal ad_campaign ids
  const { data: cohorts } = await admin
    .from("media_buyer_test_cohorts")
    .select("product_id, test_meta_campaign_id, is_active")
    .eq("workspace_id", WS);
  const testMetaCampaigns = (cohorts || []).map((c: any) => c.test_meta_campaign_id).filter(Boolean);
  console.log(`test cohorts: ${cohorts?.length ?? 0} · with meta_campaign_id: ${testMetaCampaigns.length}`);

  const { data: pubs } = await admin
    .from("ad_publish_jobs")
    .select("campaign_id, meta_campaign_id")
    .eq("workspace_id", WS)
    .in("meta_campaign_id", testMetaCampaigns.length ? testMetaCampaigns : ["__none__"]);
  const testInternalCampaigns = new Set((pubs || []).map((p: any) => p.campaign_id).filter(Boolean));
  console.log(`internal ad_campaign ids mapped to test meta campaigns: ${testInternalCampaigns.size}`);

  // 2) Meta-attributed orders in window (paginate past the 1000-row default cap)
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await admin
      .from("orders")
      .select("id, customer_id, created_at, total_cents, ad_campaign_id, attributed_utm_source, attributed_utm_campaign, financial_status")
      .eq("workspace_id", WS)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    if (!page?.length) break;
    all.push(...page);
    if (page.length < 1000) break;
  }

  const isMeta = (o: any) =>
    (o.attributed_utm_source && META_SRC.includes(String(o.attributed_utm_source).toLowerCase())) ||
    !!o.ad_campaign_id;
  const metaOrders = all.filter(isMeta).filter((o: any) => o.customer_id);
  const testOrders = metaOrders.filter((o: any) => o.ad_campaign_id && testInternalCampaigns.has(o.ad_campaign_id));

  console.log(`\norders in last ${DAYS}d: ${all.length} · Meta-attributed (w/ customer): ${metaOrders.length} · test-campaign subset: ${testOrders.length}`);

  // 3) earliest order per customer (across ALL time) for the involved customers
  const custIds = Array.from(new Set(metaOrders.map((o: any) => o.customer_id)));
  const firstOrderAt = new Map<string, string>();
  for (const grp of chunk(custIds, 300)) {
    const { data: hist } = await admin
      .from("orders")
      .select("customer_id, created_at")
      .eq("workspace_id", WS)
      .in("customer_id", grp);
    for (const h of hist || []) {
      const prev = firstOrderAt.get(h.customer_id);
      if (!prev || h.created_at < prev) firstOrderAt.set(h.customer_id, h.created_at);
    }
  }

  // 4) classify
  function split(orders: any[]) {
    let nw = 0, rep = 0, newRev = 0, repRev = 0;
    for (const o of orders) {
      const first = firstOrderAt.get(o.customer_id);
      const isNew = first && o.created_at <= first; // this order IS the customer's earliest
      if (isNew) { nw++; newRev += o.total_cents || 0; } else { rep++; repRev += o.total_cents || 0; }
    }
    const tot = nw + rep;
    return { nw, rep, tot, repShare: tot ? (rep / tot) * 100 : 0, newRev, repRev };
  }
  const mAll = split(metaOrders);
  const mTest = split(testOrders);

  const line = (label: string, s: any) =>
    console.log(`${label}: ${s.tot} orders → ${s.nw} NEW / ${s.rep} REPEAT · repeat-share ${s.repShare.toFixed(1)}% · $${(s.newRev/100).toFixed(0)} new / $${(s.repRev/100).toFixed(0)} repeat`);

  console.log("\n=== PURCHASER OVERLAP (observable conversion footprint) ===");
  line("All Meta-attributed", mAll);
  line("Test-campaign only ", mTest);
  console.log(`\nGate: research says proceed strongly on M2 (purchaser exclusion) if repeat-share > ~15%.`);
  console.log(`Note: this is the BUY-side footprint. True served-audience overlap is ≥ this (existing buyers`);
  console.log(`served but not re-buying aren't counted) — so treat this as a LOWER BOUND on contamination.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
