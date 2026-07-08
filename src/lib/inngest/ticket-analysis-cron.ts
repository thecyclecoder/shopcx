/**
 * Real-time ticket analysis cron — the feeder.
 *
 * Runs every 30 minutes. Finds closed AI tickets that haven't been analyzed since their last
 * update and enqueues one `ticket-analyze` agent_jobs row per ticket. The box worker
 * (scripts/builder-worker.ts → runTicketAnalyzeJob) drains the queue as supervised Max
 * sessions under 💬 June (CS Director) — Phase 1 of
 * docs/brain/specs/ticket-analyzer-becomes-box-agent-under-june.md.
 *
 * The prior inline `analyzeTicket()` path (a direct fetch to api.anthropic.com) is gone —
 * enqueue is cheap + never Anthropic-dependent, so the cron no longer needs its own
 * park-and-drain deferral for outages (the box lane parks its own queued rows
 * `blocked_on_dependency` when the Claude-down breaker is tripped).
 *
 * Replaces the old nightly batch (ai-nightly-analysis.ts).
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueTicketAnalyzeJob } from "@/lib/ticket-analyzer";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const ticketAnalysisCron = inngest.createFunction(
  {
    id: "ticket-analysis-cron",
    // 3 retries are still useful for the SELECT/UPDATE steps here — the actual grader work
    // now happens on the box lane, so this cron's remaining resilience story is just about
    // its own DB reads/enqueue writes.
    retries: 3,
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
      // NB: PostgREST doesn't support column-to-column comparison in .or
      // (`lt.updated_at` reads "updated_at" as a literal string, not a
      // column reference, and the whole query errors). Fetch the window
      // and filter in JS instead. Volume is small (~tens to a few
      // hundred per 30-min window) so this is fine.
      //
      // ⚠️ analyzer_locked is EXCLUDED at the source, not filtered in
      // JS — a human has vetoed the analyzer on these rows (Phase 2 of
      // human-directives-hard-gates-over-ticket-ai). Any updated_at
      // bump on a locked row (a new tag, an audit note) would otherwise
      // re-trip the close → analyze → reopen → close loop the veto is
      // there to break. Paired with the applySeverityActions
      // hard-return + the stamp-on-slip guard below.
      const { data } = await admin.from("tickets")
        .select("id, workspace_id, last_analyzed_at, updated_at, tags, analyzer_locked")
        .eq("status", "closed")
        .eq("analyzer_locked", false)
        .contains("tags", ["ai"])
        .gte("updated_at", cutoff)
        .order("updated_at", { ascending: false })
        .limit(300);
      const needs = (data || []).filter(t =>
        !t.last_analyzed_at || new Date(t.last_analyzed_at) < new Date(t.updated_at as string)
      );
      return needs.slice(0, 100); // cap per run — next cycle picks up the rest
    });

    if (!tickets.length) {
      // No tickets need analysis — the common idle path on a */30 cadence.
      // Still emit the end-of-run heartbeat before returning so cron_freshness
      // sees a beat every tick (heartbeat.ts contract: 'every monitored cron
      // calls this at the END of each run'). Without this, idle ticks emitted
      // no beat and control-tower-monitor false-flagged a healthy quiet cron
      // as dead (signature loop:ticket-analysis-cron). Mirrors the empty-path
      // heartbeat in ticket-csat.ts, deliver-pending-send.ts, abandoned-cart.ts.
      const idleResult = { queued: 0, skipped: 0 };
      await step.run("emit-heartbeat", async () => {
        await emitCronHeartbeat("ticket-analysis-cron", { ok: true, produced: idleResult });
      });
      return idleResult;
    }

    let queued = 0;
    let skipped = 0;
    const skipReasons: Record<string, number> = {};

    // Enqueue one `ticket-analyze` box job per candidate. Enqueue is idempotent per-ticket
    // (one-in-flight dedup inside enqueueTicketAnalyzeJob), so a re-selection while an earlier
    // grade is still running is a no-op skip (`already_in_flight`).
    for (const t of tickets) {
      const result = await step.run(`enqueue-${t.id}`, async () => {
        try {
          return await enqueueTicketAnalyzeJob(t.id, "auto_close");
        } catch (err) {
          console.error("[ticket-analysis-cron] enqueueTicketAnalyzeJob error:", err);
          return { ok: false as const, reason: "exception" };
        }
      });

      if (result.ok) {
        queued++;
      } else {
        skipped++;
        skipReasons[result.reason || "unknown"] = (skipReasons[result.reason || "unknown"] || 0) + 1;

        // Mark last_analyzed_at even on skip so we don't re-check the same ticket every 30
        // min. The cron is "have we looked at this since the last update?", not "has this
        // been graded?". EXCEPT `already_in_flight` — a grade is in progress and will bump
        // last_analyzed_at itself; stamping here first would race the box's own compare-and-
        // set. Same guard the prior park-and-drain path used for deferred jobs.
        if (result.reason !== "already_in_flight") {
          await admin.from("tickets")
            .update({ last_analyzed_at: new Date().toISOString() })
            .eq("id", t.id);
        }
      }
    }

    const result = { queued, skipped, skip_reasons: skipReasons };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("ticket-analysis-cron", { ok: true, produced: result });
    });

    return result;
  }
);
