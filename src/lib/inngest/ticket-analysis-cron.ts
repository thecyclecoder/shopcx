/**
 * Real-time ticket analysis cron — the feeder.
 *
 * Runs every 30 minutes. Finds closed AI tickets that haven't been analyzed since their last
 * update and enqueues one `ticket-analyze` agent_jobs row per ticket. The box worker
 * (scripts/builder-worker.ts → runTicketAnalyzeJob) drains the queue as supervised Max
 * sessions under 💬 June (CS Director) — Phase 1 of
 * docs/brain/specs/ticket-analyzer-becomes-box-agent-under-june.md.
 *
 * The prior inline grade (a direct fetch to api.anthropic.com from analyzeTicketInner) is gone —
 * enqueue is cheap + never Anthropic-dependent, so the cron no longer needs its own
 * park-and-drain deferral for outages (the box lane parks its own queued rows
 * `blocked_on_dependency` when the Claude-down breaker is tripped). The cron still routes
 * through `analyzeTicket()` (not the raw `enqueueTicketAnalyzeJob`) so its finally block emits
 * the `ai:ticket-analyzer` inline-agent feeder heartbeat once per handled ticket —
 * the Control Tower tile's liveness-when-work-exists assertion evaluates against actual feeder
 * activity, not a permanently-silent channel.
 *
 * Replaces the old nightly batch (ai-nightly-analysis.ts).
 *
 * Phase 1 of docs/brain/specs/cora-only-investigates-after-sol-handles-and-ticket-closed-30min-no-reinvestigation:
 * Cora only analyzes a ticket once, after Sol has handled it AND its closed_at is >= 30 min ago
 * AND we haven't already analyzed it for THIS Sol handling cycle. See {@link passesCoraSelectionGate}.
 *
 * Phase 2 of the same spec: a ticket that already has a `cs_director_call` decision from June
 * FOR THE CURRENT HANDLING CYCLE is ALSO excluded — Cora never re-investigates a June-decided
 * ticket on its own. Re-eligibility naturally requires a subsequent Sol handling (a new close):
 * once Sol re-handles, `tickets.sol_handled_at` advances past the prior June decision timestamp
 * and the ticket falls back into the 30-min-settle gate for the NEW handling cycle.
 *
 * Phase 2 of docs/brain/specs/cora-grades-on-deterministic-sol-handled-signal-not-brittle-direction-existence.md:
 * The 'Sol handled this ticket' signal is now the DETERMINISTIC `tickets.sol_handled_at` column
 * — stamped by the worker (scripts/builder-worker.ts runTicketHandleJob) on the box session's
 * terminal COMPLETED state via `createAdminClient()`, NOT by Sol's mid-session `writeDirection`
 * insert. Under a DB outage the mid-session Direction insert could silently drop (observed on
 * the first ~6-7 Sol-handled tickets), hiding "Sol responded" from the prior direction-existence
 * gate and starving Cora of tickets to grade. `sol_handled_at` is written by the harness after
 * Sol's plan resolves, so the signal is decoupled from the fallible per-turn insert. The 'ai'
 * tag stays as a coarse cheap pre-filter; `sol_handled_at` is the authoritative Sol-handled
 * signal. Per-cycle dedup + the June-decided guard now compare against `sol_handled_at`.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { analyzeTicket } from "@/lib/ticket-analyzer";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

/**
 * Milliseconds Cora waits after Sol handles + the ticket closes before she analyzes. The 30-min
 * settle lets the customer respond ("thanks!" / "wait, one more thing") so Cora grades the
 * settled cycle, not an in-flight one.
 */
export const CORA_CLOSE_SETTLE_MS = 30 * 60 * 1000;

/**
 * Pure predicate for the Cora selection gate — pinned in a unit test without a DB so the rule
 * is reviewable in isolation.
 *
 * Cora selects a ticket for analysis only when:
 *   1. Sol has handled it — `tickets.sol_handled_at` is set. The worker stamps this at the box
 *      session's terminal COMPLETED state, so an in-session `writeDirection` failure can't
 *      hide the fact that Sol handled the ticket (Phase 2 of
 *      cora-grades-on-deterministic-sol-handled-signal-not-brittle-direction-existence).
 *   2. The ticket has been closed_at >= {@link CORA_CLOSE_SETTLE_MS} ago (the 30-min settle).
 *   3. It has NOT already been analyzed for THIS Sol handling cycle — dedup on
 *      `sol_handled_at` (a `last_analyzed_at` at-or-after `sol_handled_at` means we already
 *      graded this handling and must skip; a stale `last_analyzed_at` from a prior handling is
 *      fine — Cora may re-grade the new cycle).
 *   4. June (CS Director) has NOT already decided this handling cycle. A `cs_director_call`
 *      `director_activity` row for this ticket with `created_at >= sol_handled_at` closes this
 *      cycle to Cora; the ticket becomes re-eligible only after Sol re-handles (a new inbound
 *      + Sol re-handle + close), which advances `sol_handled_at` past every prior June
 *      decision timestamp.
 *
 * Returns true when the ticket passes; false when any gate fails. The cron caller applies
 * `.stamp last_analyzed_at on the skip so a later updated_at bump can't re-select the same row.
 */
export function passesCoraSelectionGate(
  ticket: {
    closed_at: string | null;
    last_analyzed_at: string | null;
    sol_handled_at: string | null;
  },
  now: Date,
  latestJuneDecidedAt: string | null = null,
): boolean {
  if (!ticket.sol_handled_at) return false;
  if (!ticket.closed_at) return false;
  const closedMs = new Date(ticket.closed_at).getTime();
  if (Number.isNaN(closedMs)) return false;
  if (now.getTime() - closedMs < CORA_CLOSE_SETTLE_MS) return false;
  const solHandledMs = new Date(ticket.sol_handled_at).getTime();
  if (Number.isNaN(solHandledMs)) return false;
  if (ticket.last_analyzed_at) {
    const analyzedMs = new Date(ticket.last_analyzed_at).getTime();
    if (!Number.isNaN(analyzedMs) && analyzedMs >= solHandledMs) {
      return false;
    }
  }
  // June already decided this handling cycle → skip. A June decision from a PRIOR cycle
  // (decided_at < sol_handled_at) is fine: Sol re-handled past it, this is a new cycle that
  // hasn't been decided yet.
  if (latestJuneDecidedAt) {
    const decidedMs = new Date(latestJuneDecidedAt).getTime();
    if (!Number.isNaN(decidedMs) && decidedMs >= solHandledMs) {
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
        .select("id, workspace_id, last_analyzed_at, updated_at, closed_at, tags, analyzer_locked, sol_handled_at")
        .eq("status", "closed")
        .eq("analyzer_locked", false)
        .contains("tags", ["ai"])
        .not("closed_at", "is", null)
        .not("sol_handled_at", "is", null)
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
        sol_handled_at: string | null;
      }>;
      if (!candidates.length) return [];

      // The "Sol handled this ticket" signal is now the deterministic `tickets.sol_handled_at`
      // column, stamped by the worker on box-session completion (Phase 1 of
      // cora-grades-on-deterministic-sol-handled-signal-not-brittle-direction-existence). No
      // more per-run join against ticket_directions — an in-session `writeDirection` failure
      // no longer starves Cora of Sol-handled tickets to grade.

      // The June-decided lookup. Load every `cs_director_call` `director_activity` row scoped
      // to the candidate workspaces since the 7-day cutoff; per candidate ticket, keep the
      // MAX(created_at). The predicate then compares that vs `sol_handled_at` — a June
      // decision inside the current cycle (decided_at >= sol_handled_at) → skip; a June
      // decision in a prior cycle stays inert because Sol re-handled past it.
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
          {
            closed_at: t.closed_at,
            last_analyzed_at: t.last_analyzed_at,
            sol_handled_at: t.sol_handled_at,
          },
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

    // Enqueue one `ticket-analyze` box job per candidate — routed through the analyzeTicket
    // wrapper so its finally block emits the `ai:ticket-analyzer` inline-agent heartbeat
    // (Control Tower feeder liveness) once per handled ticket. Enqueue itself still runs inside
    // enqueueTicketAnalyzeJob (one-in-flight dedup per ticket, so a re-selection while an
    // earlier grade is still running is a no-op skip `already_in_flight`); the wrapper adds
    // only the beat + the same AnalyzeResult shape.
    for (const t of tickets) {
      const result = await step.run(`enqueue-${t.id}`, async () => {
        try {
          return await analyzeTicket(t.id, "auto_close");
        } catch (err) {
          console.error("[ticket-analysis-cron] analyzeTicket error:", err);
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
