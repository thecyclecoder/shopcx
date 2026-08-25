/**
 * CEO 2026-08-25 — the test-portfolio policy change.
 *
 *   1. `crown_min_purchases` 8 → 15. At n=8 the 95% interval on a measured $220 CPA spans
 *      $110–$440, so a "winner" could not be told apart from a $400 dud. All 5 crowned winners
 *      were crowned at 7–13 purchases; pooled post-crown CPA came in 1.89x pre-crown while scaled
 *      IN PLACE. n=15 is where the interval first separates $220 from $400.
 *      (Pairs with the confidence-bound rule in `crownUpperBoundCpaCents` — code, not config.)
 *
 *   2. `per_test_daily_budget_cents` 15000 → 20000 on every ACTIVE test cohort. Observed CPA is
 *      FLAT from $100–$200/day ($312 / $305 / $306) and only degrades above it ($337 at $300,
 *      $408 at $450). $200 is the top of the plateau: same CPA, verdicts ~25% faster, and fewer
 *      concurrent adsets bidding against each other (frequency peaks at the $150 band).
 *
 * Spend ramp now comes from BREADTH (more concurrent tests) rather than from scaling winners —
 * which the data says is value-destroying.
 *
 * IDEMPOTENT: compare-and-set. Re-running is a no-op. Writes a director_activity audit row.
 * Pass --apply to write; default is a dry run.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

const NEW_CROWN_MIN_PURCHASES = 15;
const OLD_CROWN_MIN_PURCHASES = 8;
const NEW_PER_TEST_BUDGET_CENTS = 20000;
const OLD_PER_TEST_BUDGET_CENTS = 15000;

async function main() {
  const admin = createAdminClient();
  const changes: string[] = [];

  // ── 1. crown_min_purchases on the active policy ──────────────────────────
  const { data: pol, error: pe } = await admin.from("iteration_policies")
    .select("id,crown_min_purchases,status").eq("workspace_id", WS).eq("status", "active");
  if (pe) throw new Error(`iteration_policies: ${pe.message}`);
  if (!pol?.length) throw new Error("no active iteration policy — refusing to guess");

  for (const p of pol) {
    const cur = Number(p.crown_min_purchases);
    if (cur === NEW_CROWN_MIN_PURCHASES) { console.log(`  policy ${String(p.id).slice(0, 8)} crown_min_purchases already ${cur} — no-op`); continue; }
    if (cur !== OLD_CROWN_MIN_PURCHASES) {
      console.log(`  ⚠ policy ${String(p.id).slice(0, 8)} crown_min_purchases is ${cur}, expected ${OLD_CROWN_MIN_PURCHASES} — SKIPPING (someone else changed it)`);
      continue;
    }
    changes.push(`crown_min_purchases ${cur} → ${NEW_CROWN_MIN_PURCHASES} (policy ${p.id})`);
    if (APPLY) {
      const { error } = await admin.from("iteration_policies")
        .update({ crown_min_purchases: NEW_CROWN_MIN_PURCHASES, updated_at: new Date().toISOString() })
        .eq("id", p.id).eq("crown_min_purchases", OLD_CROWN_MIN_PURCHASES); // compare-and-set
      if (error) throw new Error(`policy update: ${error.message}`);
      console.log(`  ✅ policy ${String(p.id).slice(0, 8)} crown_min_purchases → ${NEW_CROWN_MIN_PURCHASES}`);
    }
  }

  // ── 2. per_test_daily_budget_cents on every ACTIVE cohort ────────────────
  const { data: cohorts, error: ce } = await admin.from("media_buyer_test_cohorts")
    .select("id,product_id,per_test_daily_budget_cents,daily_test_ceiling_cents,is_active")
    .eq("workspace_id", WS).eq("is_active", true);
  if (ce) throw new Error(`media_buyer_test_cohorts: ${ce.message}`);

  for (const c of cohorts ?? []) {
    const cur = Number(c.per_test_daily_budget_cents);
    if (cur === NEW_PER_TEST_BUDGET_CENTS) { console.log(`  cohort ${String(c.id).slice(0, 8)} per_test already $${cur / 100} — no-op`); continue; }
    if (cur !== OLD_PER_TEST_BUDGET_CENTS) {
      console.log(`  ⚠ cohort ${String(c.id).slice(0, 8)} per_test is $${cur / 100}, expected $${OLD_PER_TEST_BUDGET_CENTS / 100} — SKIPPING`);
      continue;
    }
    changes.push(`cohort ${String(c.id).slice(0, 8)} per_test $${cur / 100} → $${NEW_PER_TEST_BUDGET_CENTS / 100}`);
    if (APPLY) {
      const { error } = await admin.from("media_buyer_test_cohorts")
        .update({ per_test_daily_budget_cents: NEW_PER_TEST_BUDGET_CENTS, updated_at: new Date().toISOString() })
        .eq("id", c.id).eq("per_test_daily_budget_cents", OLD_PER_TEST_BUDGET_CENTS);
      if (error) throw new Error(`cohort update: ${error.message}`);
      console.log(`  ✅ cohort ${String(c.id).slice(0, 8)} per_test → $${NEW_PER_TEST_BUDGET_CENTS / 100}/day`);
    }
  }

  console.log(`\n${changes.length} change(s) ${APPLY ? "APPLIED" : "PENDING (dry run — pass --apply)"}:`);
  for (const c of changes) console.log(`  · ${c}`);

  if (APPLY && changes.length) {
    const { error } = await admin.from("director_activity").insert({
      workspace_id: WS,
      director_function: "growth",
      action_kind: "media_buyer_test_portfolio_retuned",
      reason:
        `CEO 2026-08-25: crown_min_purchases ${OLD_CROWN_MIN_PURCHASES}→${NEW_CROWN_MIN_PURCHASES} and per-test budget ` +
        `$${OLD_PER_TEST_BUDGET_CENTS / 100}→$${NEW_PER_TEST_BUDGET_CENTS / 100}/day. Spend ramp now comes from BREADTH, ` +
        `not from scaling winners — measured post-crown CPA was 1.89x pre-crown while scaled in place.`,
      metadata: { changes, crown_min_purchases: NEW_CROWN_MIN_PURCHASES, per_test_daily_budget_cents: NEW_PER_TEST_BUDGET_CENTS },
    });
    if (error) console.log(`  ⚠ audit row failed (change still applied): ${error.message}`);
    else console.log("  ✅ director_activity audit row written");
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
