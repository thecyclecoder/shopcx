/**
 * Authors the "Ada reacts to approvals immediately" spec into public.specs.
 * Owner=platform (Ada), parented to the Autonomous-build mandate.
 *
 * Observed (founder-corrected 2026-07-15): the migration-apply approval sat UNPROCESSED
 * in Ada's OWN inbox for ~1h — she neither approved nor escalated. Root gap: her decision
 * loop isn't reliably triggered on a needs_approval insert (the ~1min box-loop enqueuer
 * didn't cover it and the standing-pass cron backs off to hourly because platformHasPendingWork
 * omits needs_approval). Primary fix: make her REACT immediately (approve-fast-or-escalate-fast).
 * Secondary: an additive migration then resolves to auto-approve in-lane instead of escalating.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { upsertSpec } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "ada-reacts-to-approvals-immediately-never-sits";

const PARENT =
  '[[../functions/platform]] — "Autonomous build platform" mandate: a sequential build pipeline can\'t afford an approval sitting unprocessed in Ada\'s inbox for an hour. Ada must approve-fast-or-escalate-fast on every routed approval — never sit. See [[../libraries/platform-director]] and [[../libraries/migration-safety]].';

async function main() {
  const res = await upsertSpec(
    WS,
    {
      slug: SLUG,
      title: "Ada reacts to routed approvals immediately — approve-fast-or-escalate-fast, never sits",
      summary:
        "**Brain refs:** [[../libraries/platform-director]] (`platformHasPendingWork` · `runPlatformDirectorJob` · `categoryFor`) · [[../libraries/migration-safety]] (`classifyMigrationSql`) · [[../libraries/builder-worker]] (`enqueuePlatformDirectorJobs`) · [[../libraries/control-tower-node-registry]] · [[../libraries/control-tower-heartbeat]]\n\nObserved: an additive migration-apply approval sat UNPROCESSED in Ada's own inbox ~1h — she neither approved nor escalated. She should do one within a minute. Primary fix: an event-driven reactive Inngest fn that enqueues Ada's decision the moment a Platform-routed needs_approval lands (independent of the ~1min box poll loop AND the hourly-backoff cron), plus adding needs_approval to platformHasPendingWork so the cron also stays hot as a backstop. Secondary: an additive migration then resolves to auto-approve in Ada's leash instead of escalating (classifyMigrationSql is reached, not skipped on action type).",
      owner: "platform",
      parent: PARENT,
      parent_kind: "mandate",
      parent_ref: "platform#build",
      blocked_by: [],
      priority: null,
      deferred: false,
      intended_status: "planned",
      intended_status_set_by: "ceo:dylan",
      auto_build: true,
      milestone_id: null,
      why:
        "A Platform-routed approval sat unprocessed in Ada's inbox for ~1h — she neither approved nor escalated, stalling a sequential build. Her decision is only triggered by a ~1min box-loop enqueuer (which evidently didn't cover this one) or her standing-pass cron, which backs off to hourly because platformHasPendingWork (platform-director.ts:4790-4808) omits status='needs_approval' as a pending-work signal. So an approval on an otherwise-idle workspace can wait up to the next hourly tick. Ada must react immediately and always resolve to approve-or-escalate — never sit.",
      what:
        "(1) Add a reactive Inngest fn that fires on a Platform-routed needs_approval insert and immediately enqueues Ada's platform-director decision job — reactivity that doesn't depend on the box poll loop or the cron cadence (ships with the node-completeness trio: owner in the registry, a kill_switches ancestry, and an emitReactiveHeartbeat). (2) Add a needs_approval EXISTS check to platformHasPendingWork so the standing-pass cron stays on */5 as a backstop, and correct the MONITORED_LOOPS registry cadence drift (declared 'daily' vs deployed */5). (3) Make an additive migration-apply resolve to auto-approve in Ada's leash: when the emitted action is a migration-apply, reach classifyMigrationSql on the WRAPPED SQL and route additive verdicts to apply_migration (in-leash) instead of a lone run_prod_script that categoryFor rejects on type — destructive/backfill/non-migration scripts still escalate (the boundary is preserved).",
    },
    [
      {
        position: 1,
        title: "Phase 1 — reactive approval processing: Ada decides the moment an approval lands",
        status: "planned",
        body:
          "The primary fix for the observed hour. A Platform-routed needs_approval must trigger Ada's decision within seconds, not wait on a ~1min poll loop or an hourly-backoff cron. Event-driven, with the cron kept hot as a backstop.",
        why:
          "The request sat unprocessed in Ada's inbox ~1h because her decision is only enqueued by the ~1min box loop (which didn't cover this) or the standing-pass cron, which backs off to hourly since platformHasPendingWork omits needs_approval. Event-driven enqueue removes the dependence on those and guarantees a prompt decision.",
        what:
          "Add a reactive Inngest fn (mirror build-on-eligible.ts) that, on a Platform-routed needs_approval insert, enqueues the kind='platform-director' decision job immediately (dedup on target_job_id). Add a status='needs_approval' EXISTS branch to platformHasPendingWork (platform-director.ts:4790-4808) so the cron also stays on */5 as a backstop. Ship the new reactive node with its completeness trio: an OWNER in the node registry, a kill_switches ancestry, and an end-of-run emitReactiveHeartbeat.",
        verification:
          "vitest: (a) platformHasPendingWork returns true for a workspace whose only signal is a status='needs_approval' Platform-routed job; (b) the reactive fn, given a needs_approval insert event, enqueues exactly one platform-director decision job (and is idempotent on repeat delivery). Plus a node-registry-drift check (`npm run check:node-registry-drift`) passing with the new reactive node owned + switched + heartbeated. `npx vitest run` green, `npx tsc --noEmit` clean.",
      },
      {
        position: 2,
        title: "Phase 2 — additive migration-apply self-approves in-leash (the fast decision lands as approve)",
        status: "planned",
        body:
          "Once Ada reacts promptly, an additive migration should resolve to auto-approve — not escalate. Route a verifiably-additive migration-apply into her apply_migration lane so classifyMigrationSql clears it; everything else still escalates.",
        why:
          "categoryFor (platform-director.ts:292-304) returns null for a lone run_prod_script BEFORE classifyMigrationSql (migration-safety.ts:96-136) inspects the SQL, so even a reacting Ada would escalate an additive migration to the CEO. Reaching the additive classifier lets ADD COLUMN IF NOT EXISTS / nullable / CHECK / no-backfill self-approve in ~1min.",
        what:
          "In the build worker's action tagging (builder-worker.ts:24733 run_prod_script preserve; normalizeDevActions:14947 db_mutation→run_prod_script), detect a migration-apply (scripts/apply-*-migration.ts / db_mutation), resolve its wrapped SQL, and tag apply_migration iff classifyMigrationSql(sql).severity==='additive'; otherwise leave as-is (escalates). Do NOT relax routeOutOfLeashAction (migration-safety.ts:559-590) for non-additive or non-migration scripts. Also correct the registry expectedCadence drift for the platform-director cron ('daily' → */5, with an invariant-satisfying livenessWindowMs; no sub-5-min cron).",
        verification:
          "vitest: an additive apply-*-migration.ts action resolves to an in-leash apply_migration category (Ada auto-approves), while a DROP/DELETE/backfill or a non-migration run_prod_script stays out-of-leash (escalates); and assertRegistryInvariants passes with the corrected platform-director cadence. `npx vitest run` green.",
      },
    ],
  );
  console.log("spec authored:", res.spec_id, "phases:", JSON.stringify(res.phase_ids));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
