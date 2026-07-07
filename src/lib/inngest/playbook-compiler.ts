/**
 * Playbook compiler — weekly cron.
 *
 * Mondays 12:00 UTC = 7 AM Central (during CDT), 6 AM (during CST).
 * The window (last 30 days) is a rolling one — the Monday cadence
 * just gives admins a predictable time to expect fresh proposed
 * rules in the /dashboard/settings/ai/prompts queue.
 *
 * For every workspace with any ticket_resolution_events in the last
 * 30 days, mine confirmed turns into (problem × action_shape)
 * clusters and draft a playbook-shaped sonnet_prompts row per
 * high-support cluster. The mining + drafting logic lives in
 * src/lib/playbook-compiler.ts so it's unit-testable in isolation.
 *
 * See docs/brain/inngest/playbook-compiler.md and the
 * playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks
 * spec.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { compileForWorkspace, MINING_WINDOW_DAYS } from "@/lib/playbook-compiler";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const playbookCompilerCron = inngest.createFunction(
  {
    id: "playbook-compiler",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "0 12 * * 1" },
      // Manual trigger — fire `playbook-compiler/run` from anywhere
      // (Inngest dashboard "Invoke", or an in-repo `inngest.send`)
      // to sweep out of band, e.g. right after a burst of new
      // resolution records lands.
      { event: "playbook-compiler/run" },
    ],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaces = await step.run("find-workspaces-with-resolutions", async () => {
      const windowStart = new Date(Date.now() - MINING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await admin
        .from("ticket_resolution_events")
        .select("workspace_id")
        .eq("verified_outcome", "confirmed")
        .gte("staged_at", windowStart);
      const unique = Array.from(new Set((data || []).map((r) => (r as { workspace_id: string }).workspace_id)));
      return unique;
    });

    let totalDrafted = 0;
    const perWorkspace: Array<Record<string, unknown>> = [];
    const errors: string[] = [];

    for (const workspaceId of workspaces) {
      const r = await step.run(`compile-${workspaceId}`, async () => {
        try {
          return await compileForWorkspace(workspaceId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[playbook-compiler-cron] error for", workspaceId, msg);
          return null;
        }
      });
      if (!r) {
        errors.push(`${workspaceId}: exception`);
        continue;
      }
      totalDrafted += r.drafted;
      perWorkspace.push({ workspace_id: workspaceId, ...r });
      if (r.reason && r.reason !== "no_confirmed_rows" && !r.reason.startsWith("no_cluster_over_support_min")) {
        errors.push(`${workspaceId}: ${r.reason}`);
      }
    }

    const result = {
      workspaces: workspaces.length,
      drafted: totalDrafted,
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
