/**
 * Daily AI analysis report cron.
 *
 * Runs at 11:00 UTC (= 6 AM Central during CDT, 5 AM during CST — fine,
 * the report covers a full UTC day, not a clock-aligned business day).
 *
 * For every workspace that had any ticket_analyses yesterday, generate
 * the daily report. Reports synthesize themes across the day's analyses
 * and propose sonnet_prompts + grader_prompts for admin approval.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateDailyReport } from "@/lib/daily-analysis-report";

function yesterdayUtcDate(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export const dailyAnalysisReportCron = inngest.createFunction(
  {
    id: "daily-analysis-report-cron",
    retries: 1,
    triggers: [{ cron: "0 11 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const date = yesterdayUtcDate();

    const workspaces = await step.run("find-workspaces-with-analyses", async () => {
      const dayStart = new Date(date + "T00:00:00.000Z").toISOString();
      const dayEnd = new Date(new Date(date + "T00:00:00.000Z").getTime() + 24 * 60 * 60 * 1000).toISOString();
      const { data } = await admin.from("ticket_analyses")
        .select("workspace_id")
        .gte("created_at", dayStart)
        .lt("created_at", dayEnd);
      const unique = Array.from(new Set((data || []).map(r => r.workspace_id as string)));
      return unique;
    });

    if (!workspaces.length) return { date, workspaces: 0, generated: 0 };

    let generated = 0;
    const failures: Array<{ workspace_id: string; reason: string }> = [];
    for (const workspaceId of workspaces) {
      const r = await step.run(`generate-${workspaceId}`, async () => {
        try {
          return await generateDailyReport(workspaceId, date, "cron", "system:cron");
        } catch (err) {
          console.error("[daily-analysis-report-cron] error:", err);
          return { ok: false, reason: "exception" };
        }
      });
      if (r.ok) generated++;
      else failures.push({ workspace_id: workspaceId, reason: r.reason || "unknown" });
    }

    return { date, workspaces: workspaces.length, generated, failures };
  }
);
