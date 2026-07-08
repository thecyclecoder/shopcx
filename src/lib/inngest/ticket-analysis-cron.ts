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
 *
 * Phase 1 of docs/brain/specs/cora-only-investigates-after-sol-handles-and-ticket-closed-30min-no-reinvestigation:
 * Cora only analyzes a ticket once, after Sol has handled it (there's a LIVE ticket_directions
 * row) AND its closed_at is >= 30 min ago AND we haven't already analyzed it for THIS Sol
 * handling cycle (dedup on the live Direction's `authored_at`). See {@link passesCoraSelectionGate}.
 *
 * Phase 2 of the same spec: a ticket that already has a `cs_director_call` decision from June
 * FOR THE CURRENT HANDLING CYCLE (`director_activity.created_at >= direction.authored_at`) is
 * ALSO excluded — Cora never re-investigates a June-decided ticket on its own. Re-eligibility
 * naturally requires a subsequent Sol handling (a new close): once Sol re-authors the Direction,
 * `direction.authored_at` advances past the prior June decision timestamp and the ticket falls
 * back into the Phase-1 30-min-settle gate for the NEW handling cycle.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueTicketAnalyzeJob } from "@/lib/ticket-analyzer";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

/**
 * Milliseconds Cora waits after Sol handles + the ticket closes before she analyzes. The 30-min
 * settle lets the customer respond ("thanks!" / "wait, one more thing") so Cora grades the
 * settled cycle, not an in-flight one.
 */
export const CORA_CLOSE_SETTLE_MS = 30 * 60 * 1000;

/**
 * Pure predicate for the Phase 1 + Phase 2 gate — pinned in a unit test without a DB so the
 * rule is reviewable in isolation.
 *
 * Cora selects a ticket for analysis only when:
 *   1. Sol has handled it — there is a LIVE `ticket_directions` row (authored_at is known).
 *   2. The ticket has been closed_at >= {@link CORA_CLOSE_SETTLE_MS} ago (the 30-min settle).
 *   3. It has NOT already been analyzed for THIS Sol handling cycle — dedup on the live
 *      Direction's `authored_at` (a `last_analyzed_at` at-or-after the Direction's authored_at
 *      means we already graded this handling and must skip; a stale `last_analyzed_at` from a
 *      prior handling is fine — Cora may re-grade the new cycle).
 *   4. Phase 2 — June (CS Director) has NOT already decided this handling cycle. A
 *      `cs_director_call` `director_activity` row for this ticket with
 *      `created_at >= direction.authored_at` closes this cycle to Cora; the ticket becomes
 *      re-eligible only after Sol re-authors the Direction (a new inbound + Sol re-handle +
 *      close), which advances `direction.authored_at` past every prior June decision.
 *
 * Returns true when the ticket passes; false when any gate fails. The cron caller applies
 * `.stamp last_analyzed_at on the skip so a later updated_at bump can't re-select the same row.
 */
export function passesCoraSelectionGate(
  ticket: { closed_at: string | null; last_analyzed_at: string | null },
  direction: { authored_at: string } | null,
  now: Date,
  latestJuneDecidedAt: string | null = null,
): boolean {
  if (!direction) return false;
  if (!ticket.closed_at) return false;
  const closedMs = new Date(ticket.closed_at).getTime();
  if (Number.isNaN(closedMs)) return false;
  if (now.getTime() - closedMs < CORA_CLOSE_SETTLE_MS) return false;
  const authoredMs = new Date(direction.authored_at).getTime();
  if (ticket.last_analyzed_at) {
    const analyzedMs = new Date(ticket.last_analyzed_at).getTime();
    if (!Number.isNaN(analyzedMs) && !Number.isNaN(authoredMs) && analyzedMs >= authoredMs) {
      return false;
    }
  }
  // Phase 2 — June already decided this handling cycle → skip. A June decision from a PRIOR
  // cycle (decided_at < direction.authored_at) is fine: Sol re-authored past it, this is a new
  // cycle that hasn't been decided yet.
  if (latestJuneDecidedAt) {
    const decidedMs = new Date(latestJuneDecidedAt).getTime();
    if (!Number.isNaN(decidedMs) && !Number.isNaN(authoredMs) && decidedMs >= authoredMs) {
      return false;
    }
  }
  return true;
}

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
      //
      // The 30-min-settled floor is also applied at the source: closed_at IS NOT NULL AND
      // closed_at <= (now - 30 min). Tickets closed <30 min ago are skipped entirely so Cora
      // never grades an in-flight window (the customer might still reply "thanks!").
      const settleCutoff = new Date(Date.now() - CORA_CLOSE_SETTLE_MS).toISOString();
      const { data } = await admin.from("tickets")
        .select("id, workspace_id, last_analyzed_at, updated_at, closed_at, tags, analyzer_locked")
        .eq("status", "closed")
        .eq("analyzer_locked", false)
        .contains("tags", ["ai"])
        .not("closed_at", "is", null)
        .lte("closed_at", settleCutoff)
        .gte("updated_at", cutoff)
        .order("updated_at", { ascending: false })
        .limit(300);
      const candidates = (data || []) as Array<{
        id: string;
        workspace_id: string;
        last_analyzed_at: string | null;
        updated_at: string;
        closed_at: string | null;
        tags: string[] | null;
        analyzer_locked: boolean | null;
      }>;
      if (!candidates.length) return [];

      // Load the LIVE ticket_directions rows in one batch — this is the "Sol-handled" signal +
      // the per-handling-cycle dedup key. A ticket without a live Direction is dropped: Cora
      // only investigates AFTER Sol has handled. Dedup is `last_analyzed_at >= authored_at` →
      // already graded THIS handling cycle → skip.
      const ids = candidates.map(t => t.id);
      const { data: dirRows } = await admin.from("ticket_directions")
        .select("ticket_id, authored_at")
        .in("ticket_id", ids)
        .is("superseded_at", null);
      const directionByTicket = new Map<string, { authored_at: string }>(
        (dirRows || []).map(d => [d.ticket_id as string, { authored_at: d.authored_at as string }]),
      );

      // Phase 2 — the June-decided lookup. Load every `cs_director_call` `director_activity` row
      // scoped to the candidate workspaces since the 7-day cutoff; per candidate ticket, keep the
      // MAX(created_at). The predicate then compares that vs the Direction's authored_at — a
      // June decision inside the current cycle (decided_at >= authored_at) → skip; a June
      // decision in a prior cycle stays inert because Sol re-authored past it.
      const uniqueWorkspaces = Array.from(new Set(candidates.map(t => t.workspace_id)));
      const { data: verdictRows } = await admin.from("director_activity")
        .select("metadata, created_at, workspace_id")
        .eq("action_kind", "cs_director_call")
        .in("workspace_id", uniqueWorkspaces)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false });
      const juneByTicket = new Map<string, string>();
      for (const v of (verdictRows || []) as Array<{ metadata: Record<string, unknown> | null; created_at: string }>) {
        const ticketId = v.metadata && typeof v.metadata.ticket_id === "string" ? v.metadata.ticket_id : null;
        if (!ticketId) continue;
        if (!juneByTicket.has(ticketId)) juneByTicket.set(ticketId, v.created_at);
      }

      const now = new Date();
      const needs = candidates.filter(t =>
        passesCoraSelectionGate(
          { closed_at: t.closed_at, last_analyzed_at: t.last_analyzed_at },
          directionByTicket.get(t.id) ?? null,
          now,
          juneByTicket.get(t.id) ?? null,
        ),
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
