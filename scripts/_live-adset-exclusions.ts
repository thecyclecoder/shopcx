/**
 * Do the LIVE test adsets actually carry existing-customer exclusions?
 *
 * 5 of 6 cohorts reference Superfood Tabs' audience ids while minting into other accounts, and
 * custom audiences are per-ad-account. Either Meta rejected those mints, or it accepted them
 * WITHOUT the exclusion — in which case those cold tests have been reading contaminated
 * (existing customers converting inside a "cold" test inflates conversions and flatters CPA,
 * which is exactly the signal the crown decision rests on).
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, listAdSets, getAdSetTargetingAndPixel } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");

  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_id,meta_account_name").eq("workspace_id", WS);
  const { data: cohorts } = await admin.from("media_buyer_test_cohorts")
    .select("meta_ad_account_id,test_meta_campaign_id,product_id").eq("workspace_id", WS).eq("is_active", true);
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));

  let withExcl = 0, without = 0;
  for (const c of cohorts ?? []) {
    const a = (accts ?? []).find((x) => String(x.id) === String(c.meta_ad_account_id));
    if (!a || !c.test_meta_campaign_id) continue;
    let sets;
    try { sets = await listAdSets(token, String(a.meta_account_id), String(c.test_meta_campaign_id)); } catch { continue; }
    const live = sets.filter((s) => s.effective_status === "ACTIVE");
    if (!live.length) continue;

    console.log(`\n${title.get(String(c.product_id))} — ${a.meta_account_name} (act_${a.meta_account_id})`);
    for (const s of live) {
      const t = await getAdSetTargetingAndPixel(token, s.id);
      const targeting = (t?.targeting ?? {}) as Record<string, unknown>;
      const excl = (targeting.excluded_custom_audiences ?? []) as Array<Record<string, unknown>>;
      const has = Array.isArray(excl) && excl.length > 0;
      if (has) withExcl += 1; else without += 1;
      console.log(`  ${has ? "✅" : "❌"} ${String(s.name).slice(0, 44).padEnd(44)} excluded_custom_audiences=${has ? JSON.stringify(excl.map((e) => String(e.id))) : "NONE"}`);
      if (has) {
        for (const e of excl) {
          const j = await fetch(
            `https://graph.facebook.com/v21.0/${String(e.id)}?fields=id,name,account_id&access_token=${encodeURIComponent(token)}`,
          ).then((r) => r.json()) as Record<string, unknown>;
          const owner = j.error ? "ERROR" : `act_${j.account_id}`;
          console.log(`        ${owner === `act_${a.meta_account_id}` ? "✓" : "⚠"} ${e.id} → ${owner} "${String(j.name ?? "").slice(0, 40)}"`);
        }
      }
    }
  }

  console.log(`\n=== live test adsets: ${withExcl} WITH exclusions · ${without} WITHOUT ===`);
  if (without > 0) {
    console.log(`  ${without} cold test adset(s) are running with NO existing-customer exclusion — those reads are contaminated.`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
