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
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { isRetryableThrownError } from "@/lib/anthropic-retry";

export const ticketAnalysisCron = inngest.createFunction(
  {
    id: "ticket-analysis-cron",
    // Bumped from 1 for in-run infra resilience. The outage-spanning behaviour
    // for the analyzer comes from per-ticket DEFERRAL (below) + this cron's
    // */30 cadence: a Claude outage leaves the ticket un-marked so the next
    // tick re-grades it on recovery (park-and-drain), rather than relying on a
    // single long-running run that could overlap the next tick.
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
      const idleResult = { analyzed: 0, skipped: 0 };
      await step.run("emit-heartbeat", async () => {
        await emitCronHeartbeat("ticket-analysis-cron", { ok: true, produced: idleResult });
      });
      return idleResult;
    }

    let analyzed = 0;
    let skipped = 0;
    let deferred = 0;
    const skipReasons: Record<string, number> = {};

    // Process serially — each Sonnet call is non-trivial and we don't
    // want to slam the API. step.run gives us per-ticket retry isolation.
    for (const t of tickets) {
      const result = await step.run(`analyze-${t.id}`, async () => {
        try {
          return await analyzeTicket(t.id, "auto_close");
        } catch (err) {
          // Park-and-drain (agent-outage-resilience Phase 1): a Claude/
          // dependency outage must NOT mark the ticket analyzed — that would
          // silently drop the grade for good. Flag it for deferral so we leave
          // last_analyzed_at untouched and the next */30 tick re-grades it on
          // recovery. A non-dependency (logic) error stays swallowed-and-marked
          // so one bad ticket can't wedge the batch every cycle.
          if (isRetryableThrownError(err)) {
            return { ok: false as const, reason: "deferred_dependency", _defer: true as const };
          }
          console.error("[ticket-analysis-cron] analyzeTicket error:", err);
          return { ok: false as const, reason: "exception" };
        }
      });

      if (result.ok) {
        analyzed++;
      } else if ((result as { _defer?: boolean })._defer) {
        // Deferred: leave last_analyzed_at untouched so it's re-selected next tick.
        deferred++;
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

    const result = { analyzed, skipped, deferred, skip_reasons: skipReasons };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("ticket-analysis-cron", { ok: true, produced: result });
    });

    return result;
  }
);
