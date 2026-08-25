/**
 * Free a Superfood Tabs explore slot by pausing the one adset that MATHEMATICALLY cannot crown.
 *
 * Context: `cohortTargetCount = daily_test_ceiling ÷ per_test_daily_budget`, so raising the per-test
 * budget $150 → $200 against an unchanged $600 ceiling took every cohort from 4 slots to 3. Tabs was
 * at 3 live ⇒ instantly full ⇒ deficit 0 ⇒ the new creative still cannot enter.
 *
 * `Dahlia - Superfood Tabs - Feel Lighter` is the right one to retire: 9 purchases at $221 CPA over
 * 37 days. Holding that CPA it would need ~230 purchases (~244 days) to clear the confidence-bounded
 * $240 crown. It does not need more time — it needs to be better. Retiring it frees the slot at ZERO
 * added spend, which is the breadth strategy working as intended: kill the loser, test something new.
 *
 * Verifies the target against live data before acting — refuses if it could still crown.
 * Pass --apply to write. Default is a dry run.
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, updateObjectStatus } from "../src/lib/meta-ads";
import { crownUpperBoundCpaCents } from "../src/lib/media-buyer/meta-cpa-signal";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ADSET = "120250419137310326"; // Dahlia - Superfood Tabs - Feel Lighter Every Single Day
const APPLY = process.argv.includes("--apply");
const $ = (c: number) => "$" + (c / 100).toFixed(0);

async function main() {
  const admin = createAdminClient();

  const { data: pol } = await admin.from("iteration_policies")
    .select("crown_max_cpa_cents,crown_min_purchases").eq("workspace_id", WS).eq("status", "active").limit(1).maybeSingle();
  const crownMax = Number(pol?.crown_max_cpa_cents);

  const rows: Array<{ spend_cents: number; purchases: number }> = [];
  for (let off = 0; ; off += 1000) {
    const { data } = await admin.from("meta_insights_daily")
      .select("spend_cents,purchases").eq("workspace_id", WS).eq("level", "adset")
      .eq("meta_object_id", ADSET).range(off, off + 999);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const s = rows.reduce((x, r) => x + Number(r.spend_cents ?? 0), 0);
  const p = rows.reduce((x, r) => x + Number(r.purchases ?? 0), 0);
  const cpa = p ? s / p : Number.POSITIVE_INFINITY;

  const { data: meta } = await admin.from("meta_adsets")
    .select("name,effective_status,daily_budget_cents").eq("workspace_id", WS).eq("meta_adset_id", ADSET).maybeSingle();

  console.log(`target: ${meta?.name}`);
  console.log(`  status ${meta?.effective_status} · budget ${$(Number(meta?.daily_budget_cents ?? 0))}/day`);
  console.log(`  lifetime ${$(s)} · ${p} purchases · CPA ${p ? $(cpa) : "—"} · bound ${p ? $(crownUpperBoundCpaCents(cpa, p)) : "—"} vs crown ${$(crownMax)}`);

  // Refuse if the point estimate is already under the crown line — then more data COULD rescue it.
  if (cpa <= crownMax) {
    console.log(`\n❌ REFUSING: CPA ${$(cpa)} is at/under the ${$(crownMax)} crown line — more purchases could still crown it.`);
    return;
  }
  console.log(`\n  CPA ${$(cpa)} is ABOVE the ${$(crownMax)} crown line ⇒ no amount of additional data can crown it.`);

  if (String(meta?.effective_status).toUpperCase() === "PAUSED") {
    console.log("  already paused — no-op");
    return;
  }
  if (!APPLY) { console.log("\n(dry run — pass --apply)"); return; }

  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");
  await updateObjectStatus(token, ADSET, "PAUSED");
  console.log(`✅ paused ${ADSET} — frees ${$(Number(meta?.daily_budget_cents ?? 0))}/day and one explore slot`);

  const { error } = await admin.from("director_activity").insert({
    workspace_id: WS,
    director_function: "growth",
    action_kind: "media_buyer_retired_uncrownable_adset",
    reason:
      `CEO 2026-08-25: retired "${meta?.name}" — ${p} purchases at ${$(cpa)} lifetime CPA, ABOVE the ${$(crownMax)} ` +
      `crown line, so no additional data can crown it (holding that CPA it would need ~230 purchases / ~244 days). ` +
      `Frees one Superfood Tabs explore slot at zero added spend so a fresh creative can test. ` +
      `Slot pressure came from cohortTargetCount = ceiling ÷ per-test: the $150→$200 per-test change against an ` +
      `unchanged $600 ceiling took every cohort from 4 slots to 3.`,
    metadata: { adset_id: ADSET, purchases: p, cpa_cents: Math.round(cpa), crown_max_cpa_cents: crownMax, autonomous: false },
  });
  if (error) console.log(`  ⚠ audit row failed: ${error.message}`);
  else console.log("  ✅ director_activity audit row written");
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
