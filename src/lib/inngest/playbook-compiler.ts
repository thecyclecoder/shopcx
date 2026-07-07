/**
 * Playbook compiler — Inngest cron.
 *
 * Phase 1 of playbook-compiler-becomes-box-agent-mining-full-history:
 * this cron is no longer a Sonnet-drafting sweep — it is a THIN ENQUEUER.
 * For every workspace with any mineable history it inserts ONE agent_jobs row
 * of kind `playbook-compile` (dedupe: skip if an active job already exists for
 * the workspace). The supervised box agent (scripts/builder-worker.ts →
 * runPlaybookCompileJob) reads the FULL history (tickets + ticket_analyses —
 * no 30-day floor) and persists the recurring trees to `compiled_trees`. No
 * raw Anthropic API call happens here or on the box.
 *
 * Mondays 12:00 UTC = 7 AM Central (during CDT), 6 AM (during CST). The
 * Monday cadence just gives admins a predictable time to expect fresh trees
 * in `compiled_trees` for Phase 2 to propose playbook seeds from.
 *
 * See docs/brain/inngest/playbook-compiler.md, docs/brain/tables/compiled_trees.md,
 * and docs/brain/libraries/playbook-compiler.md.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { listCompilableWorkspaces } from "@/lib/playbook-compiler";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

/** Job statuses considered "active" for the dedupe check — a workspace with an
 *  in-flight playbook-compile job is skipped so the cron never fans a second. */
const ACTIVE_JOB_STATUSES = ["queued", "queued_resume", "claimed", "building", "needs_input", "needs_approval", "blocked_on_usage"];

export const playbookCompilerCron = inngest.createFunction(
  {
    id: "playbook-compiler",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "0 12 * * 1" },
      // Manual trigger — fire `playbook-compiler/run` from anywhere
      // (Inngest dashboard "Invoke", or an in-repo `inngest.send`)
      // to enqueue an out-of-band sweep, e.g. right after a burst of new
      // ticket_analyses / resolution events lands.
      { event: "playbook-compiler/run" },
    ],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const scopes = await step.run("list-compilable-workspaces", async () => {
      return await listCompilableWorkspaces(admin);
    });

    let enqueued = 0;
    let skippedActive = 0;
    let skippedEmpty = 0;
    const perWorkspace: Array<Record<string, unknown>> = [];
    const errors: string[] = [];

    for (const scope of scopes) {
      const outcome = await step.run(`enqueue-${scope.workspaceId}`, async () => {
        try {
          if (scope.ticketAnalysisCount === 0 && scope.confirmedResolutionCount === 0) {
            return { enqueued: false, reason: "empty_history" as const };
          }

          // Dedupe: skip when an active playbook-compile job already exists for
          // the workspace (an in-flight sweep is enough — no second row).
          const { data: activeRows } = await admin
            .from("agent_jobs")
            .select("id, status")
            .eq("workspace_id", scope.workspaceId)
            .eq("kind", "playbook-compile")
            .in("status", ACTIVE_JOB_STATUSES)
            .limit(1);
          if (Array.isArray(activeRows) && activeRows.length > 0) {
            return { enqueued: false, reason: "active_job_exists" as const, active_job_id: activeRows[0].id };
          }

          const { data: inserted, error } = await admin
            .from("agent_jobs")
            .insert({
              workspace_id: scope.workspaceId,
              kind: "playbook-compile",
              // The compiler is not spec-anchored — no slug + no branch. The
              // runner keys on workspace_id alone (mirrors the research /
              // dr-content lanes' shape).
              spec_slug: "",
              spec_branch: null,
              status: "queued",
              instructions: JSON.stringify({
                triggered_by: "playbook-compiler-cron",
                mined_ticket_analyses: scope.ticketAnalysisCount,
                mined_confirmed_resolution_events: scope.confirmedResolutionCount,
              }),
              created_by: null,
            })
            .select("id")
            .single();
          if (error) return { enqueued: false, reason: `insert_failed: ${error.message}` as string };
          return { enqueued: true, reason: "enqueued" as const, job_id: (inserted as { id?: string })?.id ?? null };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[playbook-compiler-cron] error for", scope.workspaceId, msg);
          return { enqueued: false, reason: `exception: ${msg}` };
        }
      });

      perWorkspace.push({ workspace_id: scope.workspaceId, ...outcome });
      if (outcome.enqueued) enqueued++;
      else if (outcome.reason === "empty_history") skippedEmpty++;
      else if (outcome.reason === "active_job_exists") skippedActive++;
      else errors.push(`${scope.workspaceId}: ${outcome.reason}`);
    }

    const result = {
      workspaces: scopes.length,
      enqueued,
      skipped_active: skippedActive,
      skipped_empty: skippedEmpty,
      perWorkspace,
      errors: errors.slice(0, 50),
    };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("playbook-compiler", { ok: true, produced: result });
    });

    return result;
  },
);
