/**
 * approval-enqueue-director — reactive companion to the platform-director every-5-min cron for the
 * approval-decision lane ([[../specs/ada-reacts-to-approvals-immediately-never-sits]] Phase 1).
 *
 * The observed regression: a Platform-routed `needs_approval` sat unprocessed in Ada's inbox for ~1
 * hour before she approved or escalated, stalling a sequential build. Her decision is only enqueued
 * by the ~1-min box loop OR the standing-pass cron (which backs off to hourly whenever
 * `platformHasPendingWork` returns false — pre-fix that predicate omitted `needs_approval`). This
 * fn removes the dependence on either: on a `platform/approval-needed` event, we IMMEDIATELY check
 * routing + insert exactly one `kind='platform-director'` decision job for the target (dedup on
 * `target_job_id`). The event is fired fire-and-forget from the box worker's `update()` chokepoint
 * on every needs_approval transition, so the sub-minute reactor picks up the target within seconds.
 *
 * Trigger: `platform/approval-needed` (fired from `scripts/builder-worker.ts` `update()` on
 * `status='needs_approval'`). Body: a single call to `reactiveEnqueuePlatformDirectorForTarget`,
 * which enforces the same three invariants the sweep does (Platform live+autonomous · target still
 * `needs_approval` · target routes to Platform) and dedupes on `target_job_id`. The every-5-min
 * `platform-director-cron` remains the gated backstop for dropped events / cold workspaces; the
 * newly-added `needs_approval` EXISTS branch in `platformHasPendingWork` keeps the cron on the
 * every-5-min cadence (never backs off to hourly) whenever a routed approval is sitting — no
 * double-enqueue risk since dedup is on `target_job_id`.
 *
 * Concurrency `{ limit: 1, key: 'event.data.workspace_id' }` mirrors `build-on-eligible` — one
 * approval-enqueue check per workspace at a time; a burst of transitions on the same workspace
 * serializes into a single ordered chain.
 *
 * Node-completeness trio (CLAUDE.md hard rule):
 *   - Owner: `platform` (via the MONITORED_LOOPS row in [[../control-tower/registry]]).
 *   - Kill-switch ancestry: inherited from `director:platform` (parentIdForOwner in the registry).
 *   - Heartbeat: `emitReactiveHeartbeat` in a try/finally so a thrown run still beats with ok:false.
 */
import { inngest } from "@/lib/inngest/client";
import { errText } from "@/lib/error-text";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildOrgChartGraph, loadAutonomyMap } from "@/lib/agents/approval-router";
import { reactiveEnqueuePlatformDirectorForTarget } from "@/lib/agents/platform-director";
import { emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";

export const approvalEnqueueDirector = inngest.createFunction(
  {
    id: "approval-enqueue-director",
    name: "Ada — reactive enqueue on a Platform-routed needs_approval insert",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "platform/approval-needed" }],
  },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const { workspace_id, target_job_id } = (event.data ?? {}) as {
      workspace_id?: string;
      target_job_id?: string;
    };
    let ok = true;
    let result: { enqueued: boolean; reason: string } = { enqueued: false, reason: "unknown" };
    try {
      if (!workspace_id || !target_job_id) {
        result = { enqueued: false, reason: "missing-workspace-id-or-target-job-id" };
        return { status: "skipped", ...result };
      }
      result = await step.run("enqueue-if-platform-routed", async () => {
        const admin = createAdminClient();
        const { data: target } = await admin
          .from("agent_jobs")
          .select("id, workspace_id, kind, spec_slug, status, pending_actions")
          .eq("id", target_job_id)
          .maybeSingle();
        if (!target) return { enqueued: false, reason: "target-not-found" };
        const [chart, autonomy] = await Promise.all([buildOrgChartGraph(), loadAutonomyMap()]);
        return await reactiveEnqueuePlatformDirectorForTarget(
          admin,
          target as Parameters<typeof reactiveEnqueuePlatformDirectorForTarget>[1],
          chart,
          autonomy,
        );
      });
      console.log(
        `[approval-enqueue-director] ws=${workspace_id} target=${target_job_id} enqueued=${result.enqueued} reason=${result.reason}`,
      );
      return { status: "complete", ...result };
    } catch (e) {
      ok = false;
      const msg = errText(e);
      console.error(
        `[approval-enqueue-director] ws=${workspace_id} target=${target_job_id} failed: ${msg}`,
      );
      throw e;
    } finally {
      try {
        await emitReactiveHeartbeat("approval-enqueue-director", {
          ok,
          produced: { ...result, workspace_id, target_job_id },
          durationMs: Date.now() - startedAt,
        });
      } catch {
        /* best-effort — never break the run on a heartbeat failure. */
      }
    }
  },
);
