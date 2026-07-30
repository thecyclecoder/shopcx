/**
 * READ-ONLY: figure out which orders field ties an order back to the 6 test Meta
 * campaigns. Inspect the Meta-attributed orders (last 10d) and show ad_campaign_id +
 * attributed_utm_* so we can see the working join before building the overlap measure.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const META_SRC = ["facebook","fb","ig","instagram","meta","an","msg"];

async function main() {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 10 * 864e5).toISOString();

  const testMetaCampaigns = new Set<string>();
  const { data: cohorts } = await admin.from("media_buyer_test_cohorts")
    .select("test_meta_campaign_id").eq("workspace_id", WS);
  for (const c of cohorts || []) if (c.test_meta_campaign_id) testMetaCampaigns.add(String(c.test_meta_campaign_id));
  console.log("test meta campaign ids:", [...testMetaCampaigns].join(", "));

  const { data: orders } = await admin.from("orders")
    .select("id, created_at, customer_id, ad_campaign_id, attributed_utm_source, attributed_utm_medium, attributed_utm_campaign, attributed_utm_content, order_type, source_name")
    .eq("workspace_id", WS).gte("created_at", since).order("created_at", { ascending: false }).limit(1000);

  const meta = (orders || []).filter((o: any) =>
    (o.attributed_utm_source && META_SRC.includes(String(o.attributed_utm_source).toLowerCase())) || o.ad_campaign_id);
  console.log(`\nMeta-attributed orders (last 10d): ${meta.length}\n`);
  for (const o of meta) {
    console.log(`${o.created_at.slice(0,10)} src=${o.source_name} type=${o.order_type} ad_campaign_id=${o.ad_campaign_id ?? "-"}`);
    console.log(`   utm src/med/camp/content = ${o.attributed_utm_source} / ${o.attributed_utm_medium} / ${o.attributed_utm_campaign} / ${o.attributed_utm_content}`);
  }

  // does any order's ad_campaign_id resolve to a test campaign via ad_publish_jobs?
  const internalIds = [...new Set(meta.map((o: any) => o.ad_campaign_id).filter(Boolean))];
  if (internalIds.length) {
    const { data: pubs } = await admin.from("ad_publish_jobs")
      .select("campaign_id, meta_campaign_id, meta_adset_id, meta_ad_id").eq("workspace_id", WS)
      .in("campaign_id", internalIds);
    console.log(`\nad_publish_jobs for those internal campaign ids: ${pubs?.length ?? 0}`);
    for (const p of pubs || []) console.log(`   internal=${p.campaign_id} meta_campaign=${p.meta_campaign_id} isTest=${testMetaCampaigns.has(String(p.meta_campaign_id))}`);
    // also: do the internal ids exist in ad_campaigns at all?
    const { data: acs } = await admin.from("ad_campaigns").select("id, name, product_id, status").in("id", internalIds);
    console.log(`\nad_campaigns rows for those internal ids: ${acs?.length ?? 0}`);
    for (const a of acs || []) console.log(`   ${a.id} "${String(a.name).slice(0,40)}" status=${a.status}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
