/**
 * spec-drift-reconcile cron — the Control-Tower self-audit backstop for the Spec-Drift Agent (Part B).
 *
 * The merge path (reconcileMergedJobs) is the root fix — it stamps the phase(s) a build shipped ✅ the
 * moment its PR merges. This cron is the backstop that catches residual drift the event missed (box was
 * down, a PR merged on GitHub directly, a spec shipped before the agent existed). Every ~30 min it runs
 * the per-phase, evidence-gated reconciler over every drift-candidate spec, per build-console workspace:
 * auto-flips a phase ✅ only when its code is on `main` AND a build merged for the spec, surfaces the
 * ambiguous residue (code on main, no merged build on record) as a `spec_drift` row for a one-tap owner
 * flip, and leaves genuinely-pending phases (fan-out / follow-on) untouched.
 *
 * Itself a monitored loop: it beats at the end so a dead reconciler is visible on the Control Tower.
 * See docs/brain/inngest/spec-drift-reconcile.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  runSpecDriftReconciler,
  healBuiltUnstampedPhases,
  reconcileArchivedNotFolded,
  reconcileMergedBuildBranchPrs,
} from "@/lib/spec-drift";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

// The canonical PM (build-console) workspace. The built-unstamped self-heal is SINGLE-WORKSPACE by
// contract (repurpose-spec-drift-reconciler P1) — it stamps phases `shipped`, so it must never iterate
// workspaces / touch a test workspace. The DB-vs-code surface above stays multi-workspace (read-only).
const PM_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

export const specDriftReconcileCron = inngest.createFunction(
  {
    id: "spec-drift-reconcile",
    name: "Spec-drift — per-phase emoji↔code reconciler (Control Tower self-audit)",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "20,50 * * * *" }], // every ~30 min, offset from the :00/:15/:30/:45 crons
  },
  async ({ step }) => {
    const startedAt = Date.now();

    const result = await step.run("reconcile-spec-drift", async () => {
      const admin = createAdminClient();
      // Build-console workspaces = any with an agent_jobs row (matches the spec-test cron's reach).
      const { data: wsRows } = await admin.from("agent_jobs").select("workspace_id").limit(1000);
      const workspaceIds = Array.from(new Set((wsRows || []).map((r) => r.workspace_id as string)));
      if (!workspaceIds.length) return { workspaces: 0, specsScanned: 0, flipped: 0, surfaced: 0 };

      let specsScanned = 0;
      let flipped = 0;
      let surfaced = 0;
      for (const workspaceId of workspaceIds) {
        const r = await runSpecDriftReconciler(workspaceId);
        specsScanned += r.specsScanned;
        flipped += r.flipped;
        surfaced += r.surfaced;
      }
      return { workspaces: workspaceIds.length, specsScanned, flipped, surfaced };
    });

    // repurpose-spec-drift-reconciler P1: self-heal "built-unstamped" phases. After db-driven-specs, status
    // derives from spec_phases; a backfill seeded some phases `planned` whose work already merged, so the box
    // re-builds them, no-ops "already merged via #N", and the phase stays planned forever (a phantom rebuild
    // loop). The reconciler is Bo's supervisor: it reads that no-op outcome and STAMPS the phase shipped.
    // Canonical PM workspace ONLY — this mutates, so it never iterates workspaces.
    const healed = await step.run("heal-built-unstamped", async () => {
      const rows = await healBuiltUnstampedPhases(PM_WORKSPACE_ID);
      return { specs: rows.length, phases: rows.reduce((n, r) => n + r.phases.length, 0), detail: rows };
    });

    // stamp-phases-on-github-pr-merged Phase 1: MANUAL squash/merge signal. When the owner manually
    // squash-merges a `claude/build-*` PR (which the Branches page invites), the box's own merge flow
    // never fires — the three job-log signals in `healBuiltUnstampedPhases` all miss, and the squash
    // discards `build_sha` so SHA-ancestry misses too. Ask GitHub whether each unstamped spec's
    // `claude/build-{slug}` PR is MERGED; if so, stamp its phases shipped with the PR # + merge_sha.
    // Fail-closed: OPEN / CLOSED-unmerged / GitHub errors all short-circuit to no-stamp.
    const manuallyMerged = await step.run("reconcile-merged-build-branch-prs", async () => {
      const rows = await reconcileMergedBuildBranchPrs(PM_WORKSPACE_ID);
      return { specs: rows.length, phases: rows.reduce((n, r) => n + r.phases.length, 0), detail: rows };
    });

    // folded-spec-must-stay-folded: the SYMMETRIC backstop. A slug whose markdown is in docs/brain/archive.d/
    // but whose DB row reads a non-folded status (the db-reduce-calls split: a fold-race / re-author left it
    // NULL → the rollup derived `planned` → phantom on the active board + builds auto-cancelled as "spec
    // archived") gets its `folded` override re-persisted. The archive is authoritative — idempotent, never
    // false-fires. Canonical PM workspace ONLY (it mutates status), exactly like the heal step above.
    const refolded = await step.run("reconcile-archived-not-folded", async () => {
      const rows = await reconcileArchivedNotFolded(PM_WORKSPACE_ID);
      return { specs: rows.length, detail: rows };
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("spec-drift-reconcile", {
        ok: true,
        produced: {
          ...result,
          healedSpecs: healed.specs,
          healedPhases: healed.phases,
          refoldedSpecs: refolded.specs,
          manuallyMergedSpecs: manuallyMerged.specs,
          manuallyMergedPhases: manuallyMerged.phases,
        },
        detail: `${result.flipped} flipped · ${result.surfaced} surfaced · ${result.specsScanned} scanned · ${healed.specs} healed (${healed.phases} phase) · ${manuallyMerged.specs} manually-merged (${manuallyMerged.phases} phase) · ${refolded.specs} re-folded`,
        durationMs: Date.now() - startedAt,
      });
    });

    return {
      ...result,
      healedSpecs: healed.specs,
      healedPhases: healed.phases,
      refoldedSpecs: refolded.specs,
      manuallyMergedSpecs: manuallyMerged.specs,
      manuallyMergedPhases: manuallyMerged.phases,
    };
  },
);
