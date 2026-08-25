/** Map products -> ad accounts -> existing test/scaler campaigns, before minting anything. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, listCampaigns } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const WANTED = [
  "Superfood Tabs", "Amazing Coffee K-Cups", "Amazing Creamer", "Amazing Coffee",
  "Ashwavana Zen Relax", "Ashwavana Guru Focus", "Creatine Prime",
];

async function main() {
  const admin = createAdminClient();

  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_id,meta_account_name").eq("workspace_id", WS);
  const acctName = new Map((accts ?? []).map((a) => [String(a.id), String(a.meta_account_name)]));
  const acctMetaId = new Map((accts ?? []).map((a) => [String(a.id), String(a.meta_account_id)]));

  const { data: testCohorts } = await admin.from("media_buyer_test_cohorts")
    .select("product_id,meta_ad_account_id,test_meta_campaign_id,is_active,default_meta_account_id").eq("workspace_id", WS);
  const { data: scalerCohorts } = await admin.from("media_buyer_cold_scaler_cohorts")
    .select("id,product_id,scaler_meta_campaign_id,daily_scaler_ceiling_cents,is_active").eq("workspace_id", WS);

  console.log("=== PRODUCT → AD ACCOUNT → TEST COHORT → SCALER COHORT ===\n");
  for (const want of WANTED) {
    const p = (prods ?? []).find((x) => String(x.title).toLowerCase() === want.toLowerCase())
      ?? (prods ?? []).find((x) => String(x.title).toLowerCase().includes(want.toLowerCase()));
    if (!p) { console.log(`❌ ${want.padEnd(24)} NO PRODUCT ROW MATCHED`); continue; }

    const tc = (testCohorts ?? []).find((c) => c.product_id === p.id);
    const sc = (scalerCohorts ?? []).find((c) => c.product_id === p.id);
    const acctUuid = tc ? String(tc.meta_ad_account_id) : null;

    console.log(`${want}`);
    console.log(`   product      ${p.id}  "${p.title}"`);
    console.log(`   ad account   ${acctUuid ? `${acctName.get(acctUuid)} (act_${acctMetaId.get(acctUuid)})` : "⚠ NO TEST COHORT → account unknown"}`);
    console.log(`   test camp    ${tc?.test_meta_campaign_id ?? "—"}  active=${tc?.is_active ?? "—"}`);
    console.log(`   scaler       ${sc ? `${sc.scaler_meta_campaign_id} (cohort ${String(sc.id).slice(0, 8)}, ceiling $${Number(sc.daily_scaler_ceiling_cents) / 100})` : "— none"}`);
    console.log("");
  }

  // Everything already in Meta that looks like a scaler
  const token = await getMetaUserToken(WS);
  if (!token) return;
  console.log("=== EXISTING SCALER-ISH CAMPAIGNS IN META ===");
  for (const a of accts ?? []) {
    let camps;
    try { camps = await listCampaigns(token, String(a.meta_account_id)); } catch { continue; }
    const hits = camps.filter((c) => /scaler|scale/i.test(c.name));
    if (!hits.length) continue;
    console.log(`  ${a.meta_account_name}:`);
    for (const c of hits) {
      console.log(`    ${c.name}  · ${c.effective_status} · ${c.daily_budget ? `CBO $${(Number(c.daily_budget) / 100).toFixed(0)}/day` : "ABO"} · ${c.id}`);
    }
  }

  console.log("\n=== ALL PRODUCTS (for reference) ===");
  for (const p of (prods ?? []).sort((a, b) => String(a.title).localeCompare(String(b.title)))) {
    console.log(`  ${String(p.id).slice(0, 8)}  ${p.title}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
