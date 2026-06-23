/**
 * Director EOD recap cron (directors-board-gamified spec, Phase 4).
 *
 * Runs at 23:00 UTC — end of the UTC day — and, for every workspace that saw director activity today
 * (any director_activity row, approval decision, or merged build), posts the EOD standup: a `recap`
 * board message + a Daily Summaries notification per active director, plus a CEO company-standup
 * roll-up. Mirrors daily-analysis-report-cron's find-workspaces → per-workspace shape; the narration
 * is deterministic + display-only (no LLM, no API key) — the recap counts are a derived proxy, never an
 * objective (operational-rules § North star). See docs/brain/inngest/director-recap-cron.md.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateDirectorRecap } from "@/lib/agents/director-recap";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export const directorRecapCron = inngest.createFunction(
  {
    id: "director-recap-cron",
    retries: 1,
    triggers: [{ cron: "0 23 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const date = todayUtcDate();
    const dayStart = new Date(date + "T00:00:00.000Z").toISOString();
    const dayEnd = new Date(new Date(date + "T00:00:00.000Z").getTime() + 24 * 60 * 60 * 1000).toISOString();

    // Workspaces with any director-domain activity today (the recap sources: activity · approvals · merges).
    const workspaces = await step.run("find-workspaces-with-activity", async () => {
      const ids = new Set<string>();
      const [activity, approvals, merges] = await Promise.all([
        admin.from("director_activity").select("workspace_id").gte("created_at", dayStart).lt("created_at", dayEnd),
        admin.from("approval_decisions").select("workspace_id").gte("created_at", dayStart).lt("created_at", dayEnd),
        // merged builds key off updated_at (the merge flip), not created_at.
        admin.from("agent_jobs").select("workspace_id").eq("kind", "build").eq("status", "merged").gte("updated_at", dayStart).lt("updated_at", dayEnd),
      ]);
      for (const r of [...(activity.data ?? []), ...(approvals.data ?? []), ...(merges.data ?? [])]) {
        if (r.workspace_id) ids.add(r.workspace_id as string);
      }
      return Array.from(ids);
    });

    let posted = 0;
    const skipped: Array<{ workspace_id: string; reason: string }> = [];
    for (const workspaceId of workspaces) {
      const r = await step.run(`recap-${workspaceId}`, async () => {
        try {
          return await generateDirectorRecap(workspaceId, date);
        } catch (err) {
          console.error("[director-recap-cron] error:", err);
          return { ok: false, reason: "exception" };
        }
      });
      if (r.ok) posted++;
      else skipped.push({ workspace_id: workspaceId, reason: r.reason || "unknown" });
    }

    const result = { date, workspaces: workspaces.length, posted, skipped };

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("director-recap-cron", { ok: true, produced: result });
    });

    return result;
  }
);
