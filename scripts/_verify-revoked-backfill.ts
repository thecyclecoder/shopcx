/** Did the revoked_at backfill land, and would the stall counter now read 0? READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { countEligibleCrownedWinnersByCohort } from "../src/lib/media-buyer/cold-scaler-graduate-heartbeat";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  const { data: w, error } = await admin.from("media_buyer_crowned_winners")
    .select("test_meta_adset_id,graduated_at,exploit_exhausted,revoked_at,revoked_reason").eq("workspace_id", WS);
  if (error) throw new Error(`crowned_winners: ${error.message}`);
  console.log("crown markers after the backfill:");
  for (const r of w ?? []) {
    console.log(`  ${String(r.test_meta_adset_id).slice(-10)} graduated=${r.graduated_at ?? "—"} exhausted=${r.exploit_exhausted} revoked_at=${String(r.revoked_at ?? "NULL").slice(0, 10)}`);
  }
  console.log(`  reason sample: ${String((w ?? [])[0]?.revoked_reason ?? "—").slice(0, 120)}`);

  const { data: cohorts } = await admin.from("media_buyer_cold_scaler_cohorts")
    .select("id,product_id,meta_ad_account_id").eq("workspace_id", WS).eq("is_active", true);
  const scopes = (cohorts ?? []).map((c) => ({
    cohortId: String(c.id),
    metaAdAccountId: c.meta_ad_account_id ? String(c.meta_ad_account_id) : null,
    productId: c.product_id ? String(c.product_id) : null,
  }));

  const counts = await countEligibleCrownedWinnersByCohort(admin, { workspaceId: WS, cohortScopes: scopes });
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));

  console.log("\neligible crowned winners per cohort (the number the stall card cites):");
  let total = 0;
  for (const s of scopes) {
    const n = counts.get(s.cohortId) ?? 0;
    total += n;
    console.log(`  ${String(title.get(String(s.productId)) ?? s.productId).padEnd(24)} ${s.cohortId.slice(0, 8)}  ${n}`);
  }
  console.log(`\n  ${total === 0 ? "✅ zero eligible — no cohort has genuine pending graduate work, so no stall card is warranted." : `⚠ ${total} eligible — stall cards for those cohorts are CORRECT.`}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
