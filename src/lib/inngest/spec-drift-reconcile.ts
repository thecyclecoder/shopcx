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
import { runSpecDriftReconciler } from "@/lib/spec-drift";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

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

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("spec-drift-reconcile", {
        ok: true,
        produced: result,
        detail: `${result.flipped} flipped · ${result.surfaced} surfaced · ${result.specsScanned} scanned`,
        durationMs: Date.now() - startedAt,
      });
    });

    return result;
  },
);
