/**
 * triage-escalations cron — the hourly trigger for the box's escalation triage lane.
 *
 * Phase 1 of june-review-replaces-solver-skeptic-quorum-triage rewires this cron: instead of
 * enqueueing ONE `triage-escalations` sweep job per workspace (which then ran a solver→skeptic→
 * quorum loop over every eligible ticket), it now enqueues ONE `cs-director-call` job PER eligible
 * escalated ticket. June's review IS the primary triage — she reads the ticket handling
 * (`ticket_resolution_events`) + the analyzer's grade + issue tags (`ticket_analyses`) + the ticket
 * conversation and emits ONE verdict { approve_remedy | author_spec | escalate_founder }. The
 * worker (`runCsDirectorCallJob`) records the verdict to `director_activity` and to `triage_runs`
 * so the audit trail reflects the leaner path. See docs/brain/specs/june-review-replaces-solver-
 * skeptic-quorum-triage.md and docs/brain/libraries/cs-director.md.
 *
 * Eligibility — a ticket qualifies for a June review when it is routine-owned + escalated + not
 * archived/closed AND does NOT already have:
 *   - an inflight `cs-director-call` job (spec_slug = ticket id) — no dup enqueue per hourly tick,
 *   - a `triage_runs` row that COVERS THE CURRENT ESCALATION LIFECYCLE — a review whose `created_at`
 *     is at or after the ticket's current `escalated_at`. Older reviews from a PRIOR escalation
 *     don't block a freshly re-escalated ticket (docs/brain/specs/triage-escalations-prior-review-
 *     lifecycle-guard.md — 472310cc-shaped tickets that were resolved, then escalated again).
 *
 * The cron does NOT reason itself — it is purely the enqueue. See docs/brain/inngest/triage-
 * escalations.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

// Small per-tick cap so a workspace with a large escalated backlog does not blow the cs-director-
// call lane in a single tick. Matches the box's triage cap semantics (`TRIAGE_CAP` = 5) — the
// remainder drain on the next hourly tick.
const JUNE_REVIEW_ENQUEUE_CAP_PER_TICK = Number(process.env.JUNE_REVIEW_ENQUEUE_CAP_PER_TICK || 20);

/**
 * Ticket-level eligibility for June's escalation triage — pinned in a unit test so the invariant
 * is reviewable in isolation without a DB.
 *
 * Phase 1 of docs/brain/specs/guard-block-escalations-reach-junes-triage-not-left-unreviewed:
 * every routine-owned escalated ticket qualifies for June's review REGARDLESS of what escalated it.
 * The `escalation_reason` field is NOT read — an orchestrator escalation, an analyzer rail hit, and
 * a playbook guard-block (e.g. `blocked_unbacked_claim:cancel`) are all eligible on the same terms.
 * A guard-block ticket that sat open + escalated with zero triage_runs is the failing state this
 * predicate exists to prevent.
 *
 * Returns true when the ticket is a triage candidate:
 *   - `escalated_at` is set (a hand-off to the routine actually happened)
 *   - `escalated_to` is null (the routine — not a specific human — owns it)
 *   - `status` is not archived/closed (a closed ticket has no live escalation to triage)
 *
 * Dedupe against inflight `cs-director-call` jobs and prior `triage_runs` is orthogonal — those
 * gates live at the enqueue site and are escalation-source-agnostic in the same way.
 */
export function passesJuneReviewSelection(ticket: {
  escalated_at: string | null;
  escalated_to: string | null;
  status: string | null;
}): boolean {
  if (!ticket.escalated_at) return false;
  if (ticket.escalated_to !== null) return false;
  if (ticket.status === "archived" || ticket.status === "closed") return false;
  return true;
}

/**
 * Lifecycle-aware prior-review guard — pinned in a unit test so the invariant is reviewable in
 * isolation without a DB.
 *
 * The historical guard skipped any ticket that had *ever* had a `triage_runs` row. That treated an
 * old June review as proof the CURRENT escalation was handled, which left re-escalated tickets
 * (resolved once, then escalated again after a new customer message) unreviewed until a human
 * noticed the Control Tower tile go red.
 *
 * The lifecycle-aware guard only suppresses a review recorded AT OR AFTER the ticket's current
 * `escalated_at`. If the ticket's latest triage_runs row predates the current escalation, the
 * current escalation is unreviewed and the cron should enqueue a fresh cs-director-call.
 *
 * Returns true when a prior review COVERS the current escalation (⇒ skip enqueue).
 * Returns false when a fresh review is needed (⇒ enqueue).
 */
export function priorReviewCoversCurrentEscalation(
  ticketEscalatedAt: string | null,
  latestTriageRunAt: string | null,
): boolean {
  // A ticket without a current escalation isn't a triage candidate at all — the ticket-level
  // predicate already filters those out; treat "no escalation" as "nothing to cover".
  if (!ticketEscalatedAt) return false;
  // No prior review at all ⇒ current escalation is unreviewed.
  if (!latestTriageRunAt) return false;
  const runAt = Date.parse(latestTriageRunAt);
  const escAt = Date.parse(ticketEscalatedAt);
  if (Number.isNaN(runAt) || Number.isNaN(escAt)) return false;
  return runAt >= escAt;
}

export const triageEscalationsCron = inngest.createFunction(
  {
    id: "triage-escalations-cron",
    name: "Escalation triage — hourly June-review enqueue",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "30 * * * *" }], // every hour at :30 (offset from portal-auto-resume's :15)
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const result = await step.run("enqueue-june-review-jobs", async () => {
      // Routine-owned escalated tickets: escalated_at set, escalated_to null (analyzer routed to
      // the routine, not a human), not archived/closed. Ordered oldest-first so a large backlog
      // drains in escalation order across ticks. `escalation_reason` is fetched for logging /
      // downstream shape but MUST NOT gate eligibility — see {@link passesJuneReviewSelection}.
      const { data: tickets } = await admin
        .from("tickets")
        .select("id, workspace_id, escalated_at, escalated_to, status, escalation_reason")
        .not("escalated_at", "is", null)
        .is("escalated_to", null)
        .not("status", "in", '("archived","closed")')
        .order("escalated_at", { ascending: true });
      // Defense-in-depth: the SQL filter above already narrows to ticket-level eligibility, but the
      // pure predicate re-asserts the invariant on the fetched rows so a future SQL edit that
      // accidentally leaks an ineligible ticket (e.g. escalated_to set by a race) can't reach
      // enqueue. Crucially, the predicate NEVER reads escalation_reason — a guard-block escalation
      // (blocked_unbacked_claim:*) is a triage candidate on the SAME terms as an analyzer-rail
      // escalation. Phase 1 of guard-block-escalations-reach-junes-triage-not-left-unreviewed.
      const fetched = (tickets || []) as {
        id: string;
        workspace_id: string;
        escalated_at: string | null;
        escalated_to: string | null;
        status: string | null;
        escalation_reason: string | null;
      }[];
      const rows = fetched.filter(passesJuneReviewSelection);
      if (!rows.length) return { eligible: 0, deferred: 0, enqueued: 0 };
      const ticketIds = rows.map((t) => t.id);

      // Dedupe against inflight cs-director-call jobs (spec_slug = ticket id) — the
      // `enqueueTicketAnalyzeJob` pattern in src/lib/ticket-analyzer.ts uses the same shape so the
      // box's per-slug queue view surfaces one row per ticket.
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("spec_slug")
        .eq("kind", "cs-director-call")
        .in("spec_slug", ticketIds)
        .in("status", ["queued", "queued_resume", "claimed", "building", "needs_input"]);
      const inflightSlugs = new Set((inflight || []).map((j) => j.spec_slug as string));

      // Dedupe against triage_runs — lifecycle-aware. A prior review only counts if it was
      // recorded AT OR AFTER the ticket's current `escalated_at`; older rows from a previous
      // escalation lifecycle don't block a freshly re-escalated ticket. See
      // {@link priorReviewCoversCurrentEscalation} — the invariant is pinned in
      // src/lib/inngest/triage-escalations.selection.test.ts. Ordered `created_at desc` so the
      // first row per ticket_id is that ticket's most recent triage_runs entry (uses the
      // `triage_runs_ticket_idx (ticket_id, created_at desc)` index).
      const { data: prior } = await admin
        .from("triage_runs")
        .select("ticket_id, created_at")
        .in("ticket_id", ticketIds)
        .order("created_at", { ascending: false });
      const latestReviewAt = new Map<string, string>();
      for (const r of (prior || []) as { ticket_id: string; created_at: string }[]) {
        if (!latestReviewAt.has(r.ticket_id)) latestReviewAt.set(r.ticket_id, r.created_at);
      }

      const eligible = rows.filter(
        (t) =>
          !inflightSlugs.has(t.id) &&
          !priorReviewCoversCurrentEscalation(t.escalated_at, latestReviewAt.get(t.id) ?? null),
      );
      const capped = eligible.slice(0, JUNE_REVIEW_ENQUEUE_CAP_PER_TICK);

      let enqueued = 0;
      for (const t of capped) {
        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: t.workspace_id,
          spec_slug: t.id, // ticket id → per-ticket per-slug queue view, same shape as ticket-analyze
          kind: "cs-director-call",
          status: "queued",
          instructions: JSON.stringify({ ticket_id: t.id }),
          created_by: null,
        });
        if (!error) enqueued++;
      }
      return {
        eligible: eligible.length,
        deferred: Math.max(0, eligible.length - capped.length),
        enqueued,
      };
    });

    // Control Tower: end-of-run heartbeat (control-tower spec, Phase 1). The cron id is unchanged
    // so the registered watcher entry (control-tower/registry.ts) keeps its liveness window.
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("triage-escalations-cron", { ok: true, produced: result });
    });

    return result;
  },
);
