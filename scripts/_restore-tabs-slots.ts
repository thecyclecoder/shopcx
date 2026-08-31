/**
 * Restore Superfood Tabs to 4 concurrent test slots at the new $200/day per-test budget.
 *
 * `cohortTargetCount = daily_test_ceiling_cents ÷ per_test_daily_budget_cents`. Raising per-test
 * $150 → $200 against an unchanged $600 ceiling silently took every cohort from 4 slots to 3 — Tabs
 * was already at 3 live, so it went straight to full and the new creative could not enter.
 *
 * Raising ONLY the Tabs ceiling $600 → $800 restores 4 × $200. Deliberately not applied to the other
 * cohorts: Tabs is the only account earning its CPP ($305 vs Ashwavana $600, Coffee & Creamer $505),
 * so the extra breadth belongs there. Adds $200/day against $403/day of headroom under the Phase 1
 * plan, and retires nothing.
 *
 * IDEMPOTENT compare-and-set. Pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS_PRODUCT = "221d272d-a6c5-4a5d-86ff-ac693926c992";
const OLD_CEILING = 60000;
const NEW_CEILING = 80000;
const APPLY = process.argv.includes("--apply");
const $ = (c: number) => "$" + (c / 100).toFixed(0);

async function main() {
  const admin = createAdminClient();
  const { data: c, error } = await admin.from("media_buyer_test_cohorts")
    .select("id,daily_test_ceiling_cents,per_test_daily_budget_cents,is_active")
    .eq("workspace_id", WS).eq("product_id", TABS_PRODUCT).maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) throw new Error("no Superfood Tabs cohort");

  const cur = Number(c.daily_test_ceiling_cents);
  const perTest = Number(c.per_test_daily_budget_cents);
  console.log(`Superfood Tabs cohort ${String(c.id).slice(0, 8)}`);
  console.log(`  ceiling  ${$(cur)}/day · per-test ${$(perTest)}/day ⇒ ${Math.floor(cur / perTest)} slots`);
  console.log(`  target   ${$(NEW_CEILING)}/day ⇒ ${Math.floor(NEW_CEILING / perTest)} slots`);

  if (cur === NEW_CEILING) { console.log("  already at target — no-op"); return; }
  if (cur !== OLD_CEILING) { console.log(`  ⚠ ceiling is ${$(cur)}, expected ${$(OLD_CEILING)} — SKIPPING`); return; }
  if (!APPLY) { console.log("\n(dry run — pass --apply)"); return; }

  const { error: ue } = await admin.from("media_buyer_test_cohorts")
    .update({ daily_test_ceiling_cents: NEW_CEILING, updated_at: new Date().toISOString() })
    .eq("id", c.id).eq("daily_test_ceiling_cents", OLD_CEILING);
  if (ue) throw new Error(`update: ${ue.message}`);
  console.log(`  ✅ ceiling ${$(OLD_CEILING)} → ${$(NEW_CEILING)}/day (${Math.floor(NEW_CEILING / perTest)} slots at ${$(perTest)})`);

  const { error: ae } = await admin.from("director_activity").insert({
    workspace_id: WS,
    director_function: "growth",
    action_kind: "media_buyer_cohort_ceiling_raised",
    reason:
      `CEO 2026-08-25: Superfood Tabs test ceiling ${$(OLD_CEILING)} → ${$(NEW_CEILING)}/day, restoring 4 concurrent ` +
      `test slots at the new ${$(perTest)}/day per-test budget. cohortTargetCount = ceiling ÷ per-test, so the ` +
      `$150→$200 per-test change against an unchanged $600 ceiling had silently cut every cohort from 4 slots to 3 ` +
      `and sealed Tabs at 3 live. Applied to Tabs ONLY — it is the sole account earning its CPP ($305 vs Ashwavana ` +
      `$600, Coffee & Creamer $505), so the extra breadth belongs there.`,
    metadata: { cohort_id: c.id, ceiling: { from: OLD_CEILING, to: NEW_CEILING }, per_test_daily_budget_cents: perTest, slots: { from: 3, to: 4 }, autonomous: false },
  });
  if (ae) console.log(`  ⚠ audit row failed: ${ae.message}`);
  else console.log("  ✅ director_activity audit row written");
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
