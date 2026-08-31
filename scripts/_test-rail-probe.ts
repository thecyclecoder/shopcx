/**
 * Why did the Iteration Engine scale a TEST adset when loadTestRailExcludedObjectIds
 * is supposed to make the test rail opaque? Rebuilds the exclusion set exactly as
 * src/lib/meta/decision-engine.ts does and checks the adsets it actually scaled on Aug 24.
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SCALED = ["120249298369230682", "120249488919900682", "120250143054030326"];

async function main() {
  const admin = createAdminClient();

  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_name").eq("workspace_id", WS);

  for (const a of accts ?? []) {
    const adAccountId = String(a.id);
    const excluded = new Set<string>();

    const { data: cohortRows, error: ce } = await admin.from("media_buyer_test_cohorts")
      .select("test_meta_campaign_id, test_meta_adset_id")
      .eq("workspace_id", WS).eq("meta_ad_account_id", adAccountId).eq("is_active", true);
    if (ce) { console.log(`  cohort read error: ${ce.message}`); continue; }

    const testCampaignIds: string[] = [];
    for (const r of cohortRows ?? []) {
      if (r.test_meta_campaign_id) { excluded.add(String(r.test_meta_campaign_id)); testCampaignIds.push(String(r.test_meta_campaign_id)); }
      if (r.test_meta_adset_id) excluded.add(String(r.test_meta_adset_id));
    }

    let adsetRowCount = 0;
    if (testCampaignIds.length) {
      const { data: adsetRows, error: ae } = await admin.from("meta_adsets")
        .select("meta_adset_id").eq("workspace_id", WS).in("meta_campaign_id", testCampaignIds);
      if (ae) console.log(`  ⚠ meta_adsets read ERROR (silently swallowed in prod): ${ae.message}`);
      adsetRowCount = (adsetRows ?? []).length;
      for (const r of adsetRows ?? []) if (r.meta_adset_id) excluded.add(String(r.meta_adset_id));
    }

    console.log(`\n${a.meta_account_name}`);
    console.log(`  active cohorts: ${(cohortRows ?? []).length} · test campaigns: ${testCampaignIds.join(", ") || "none"}`);
    console.log(`  meta_adsets rows under those campaigns: ${adsetRowCount}`);
    console.log(`  exclusion set size: ${excluded.size}`);
    for (const id of SCALED) {
      if (excluded.has(id)) console.log(`    ${id}  ✅ EXCLUDED (rail would block)`);
    }
  }

  // How complete is meta_adsets overall?
  const { count: total } = await admin.from("meta_adsets").select("id", { count: "exact", head: true }).eq("workspace_id", WS);
  console.log(`\nmeta_adsets total rows for workspace: ${total}`);
  const { data: sample } = await admin.from("meta_adsets")
    .select("meta_adset_id,meta_campaign_id,updated_at").eq("workspace_id", WS)
    .order("updated_at", { ascending: false }).limit(5);
  console.log("most recently synced meta_adsets rows:");
  for (const s of sample ?? []) console.log(`  adset=${s.meta_adset_id} campaign=${s.meta_campaign_id} updated=${String(s.updated_at).slice(0, 16)}`);

  console.log("\nare the SCALED adsets present in meta_adsets at all?");
  const { data: hit } = await admin.from("meta_adsets")
    .select("meta_adset_id,meta_campaign_id,created_at,updated_at").eq("workspace_id", WS).in("meta_adset_id", SCALED);
  for (const id of SCALED) {
    const row = (hit ?? []).find((h) => String(h.meta_adset_id) === id);
    console.log(`  ${id}  ${row ? `present · row created ${String(row.created_at).slice(0, 16)} (campaign ${row.meta_campaign_id})` : "MISSING from meta_adsets"}`);
  }

  // When did meta_adsets first get rows for each TEST campaign?
  console.log("\nearliest meta_adsets row per test campaign (the rail is blind before this):");
  const { data: allRows } = await admin.from("meta_adsets")
    .select("meta_campaign_id,created_at").eq("workspace_id", WS);
  const earliest: Record<string, string> = {};
  for (const r of allRows ?? []) {
    const k = String(r.meta_campaign_id), c = String(r.created_at);
    if (!earliest[k] || c < earliest[k]) earliest[k] = c;
  }
  for (const [k, v] of Object.entries(earliest).sort((a, b) => a[1].localeCompare(b[1]))) {
    console.log(`  campaign ${k}  first row ${v.slice(0, 16)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
