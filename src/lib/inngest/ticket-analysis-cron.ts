/**
 * Real-time ticket analysis cron.
 *
 * Runs every 30 minutes. Finds closed AI tickets that haven't been
 * analyzed since their last update, runs the grader on each.
 *
 * Replaces the old nightly batch (ai-nightly-analysis.ts).
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyzeTicket } from "@/lib/ticket-analyzer";

export const ticketAnalysisCron = inngest.createFunction(
  {
    id: "ticket-analysis-cron",
    retries: 1,
    triggers: [{ cron: "*/30 * * * *" }],  // every 30 min
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Find closed tickets needing analysis: closed status, has 'ai' tag,
    // last_analyzed_at is null OR older than the latest update.
    // We bound the search to last 7 days to avoid re-analyzing ancient
    // tickets that just got nudged by some background job.
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const tickets = await step.run("find-tickets", async () => {
      const { data } = await admin.from("tickets")
        .select("id, workspace_id, last_analyzed_at, updated_at, tags")
        .eq("status", "closed")
        .contains("tags", ["ai"])
        .gte("updated_at", cutoff)
        .or("last_analyzed_at.is.null,last_analyzed_at.lt.updated_at")
        .order("updated_at", { ascending: false })
        .limit(100); // cap per run — next cycle picks up the rest
      return data || [];
    });

    if (!tickets.length) {
      return { analyzed: 0, skipped: 0 };
    }

    let analyzed = 0;
    let skipped = 0;
    const skipReasons: Record<string, number> = {};

    // Process serially — each Sonnet call is non-trivial and we don't
    // want to slam the API. step.run gives us per-ticket retry isolation.
    for (const t of tickets) {
      const result = await step.run(`analyze-${t.id}`, async () => {
        try {
          return await analyzeTicket(t.id, "auto_close");
        } catch (err) {
          console.error("[ticket-analysis-cron] analyzeTicket error:", err);
          return { ok: false, reason: "exception" };
        }
      });

      if (result.ok) {
        analyzed++;
      } else {
        skipped++;
        skipReasons[result.reason || "unknown"] = (skipReasons[result.reason || "unknown"] || 0) + 1;

        // Mark last_analyzed_at even on skip so we don't re-check the
        // same ticket every 30 min. The cron is "have we looked at this
        // since the last update?", not "has this been analyzed?".
        await admin.from("tickets")
          .update({ last_analyzed_at: new Date().toISOString() })
          .eq("id", t.id);
      }
    }

    return { analyzed, skipped, skip_reasons: skipReasons };
  }
);
