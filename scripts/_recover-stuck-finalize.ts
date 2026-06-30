/**
 * One-off recovery for the 4 finalize-orphaned specs (box-outage + live finalize-drop), via the SANCTIONED
 * reconcilers — NOT hand-poked state. Each spec is recovered through the SAME helper its standing-pass
 * backstop now runs every tick, so this is just a manual first-fire of the durable fix.
 *
 *  - appstle-attempt-billing-coerce-string-id  → healBuiltUnstampedPhases (both phases already on main via #891 → shipped)
 *  - growth-adopt-storefront-optimizer         → detectAndEnqueueDirtyPrs (PR #878 conflicting → enqueue pr-resolve → auto-merge)
 *  - fix-growth-allocation-brain-3fd059        → defer (regression already resolved upstream; no code to ship)
 *  - kpi-audit-regression-coverage-current-state → defer (PR #847 deliberately closed as redundant, superseded by #848/folded)
 *
 * Pass --apply to write; default is a dry-run that just prints what it WOULD do.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { healBuiltUnstampedPhases } from "@/lib/spec-drift";
import { detectAndEnqueueDirtyPrs } from "@/lib/github-pr-resolve";
import { setSpecStatus } from "@/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
// The two deferrals diverge from the literal "merge/stamp these" instruction (the work is obsolete/redundant,
// so NO merge is the correct outcome). Gated behind a SEPARATE flag so the contested judgment call is opt-in.
const DEFER = process.argv.includes("--defer-obsolete");
const log = (m: string) => console.log(`${APPLY ? "[APPLY]" : "[DRY] "} ${m}`);

(async () => {
  const admin = createAdminClient();

  // ── Class A — built-not-stamped, work already on main (appstle via #891) ──────────────────────────
  log("A) healBuiltUnstampedPhases — stamp phases shipped from the 'already merged via #N' signal");
  if (APPLY) {
    const healed = await healBuiltUnstampedPhases(WS);
    if (healed.length) for (const h of healed) log(`   healed ${h.slug}: phases P${h.phases.join(", P")} (pr ${h.pr})`);
    else log("   healed nothing (no candidate carried an already-merged-via-#N signal)");
  } else {
    log("   (would run healBuiltUnstampedPhases — expect appstle-attempt-billing-coerce-string-id P1+P2 → shipped via #891)");
  }

  // ── Class B — green one-off, branch never merged (storefront-optimizer #878 conflicting) ──────────
  log("B) detectAndEnqueueDirtyPrs — enqueue pr-resolve for conflicting open claude PRs (→ later auto-merge)");
  if (APPLY) {
    const dp = await detectAndEnqueueDirtyPrs(admin);
    log(`   checked ${dp.checked} claude PRs · ${dp.conflicting} conflicting · ${dp.enqueued} pr-resolve enqueued · ${dp.closedDuplicate} duplicate(s) closed`);
    for (const p of dp.prs.filter((x) => x.mergeable === false)) log(`     PR #${p.number} (${p.branch}) enqueued=${p.enqueued} closedDup=${p.closedDuplicate ?? false}`);
  } else {
    log("   (would run detectAndEnqueueDirtyPrs — expect PR #878 growth-adopt-storefront-optimizer → pr-resolve enqueued)");
  }

  // ── Deferrals — specs whose work is obsolete/redundant (no merge is the CORRECT outcome) ──────────
  const defers: Array<{ slug: string; reason: string }> = [
    {
      slug: "fix-growth-allocation-brain-3fd059",
      reason: "regression already resolved upstream — meta-performance.ts conflict-free on main + tsc passes; no code change needed (growth-allocation-brain's next spec-test re-run passes)",
    },
    {
      slug: "kpi-audit-regression-coverage-current-state",
      reason: "redundant — superseded by #848 (kpi-audit-skip-live-spec-set-dependent-metrics, folded); PR #847 deliberately closed, work already on main on the correct axis",
    },
  ];
  for (const d of defers) {
    log(`C) defer ${d.slug} — ${d.reason}`);
    if (APPLY && DEFER) {
      await setSpecStatus(WS, d.slug, "deferred", "recovery:stuck-finalize");
      log(`   set status='deferred' for ${d.slug}`);
    } else {
      log(`   SKIPPED (pass --defer-obsolete to apply this contested judgment call — left for the owner)`);
    }
  }

  process.exit(0);
})();
