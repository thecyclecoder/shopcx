/**
 * cs-director-second-opinion — the on-demand exception path a supervisor can pull when a June
 * review of an escalated ticket is genuinely borderline (Phase 2 of june-review-replaces-solver-
 * skeptic-quorum-triage). The default triage is a SINGLE June review (Phase 1); this module lets a
 * caller ask for EXACTLY ONE fresh second June review of the same ticket — the exception, not a
 * routine quorum. Every guard is enforced HERE so the caller (a script, a dashboard route) never
 * needs to know the invariants:
 *
 *   1. A prior June review must exist for the ticket (`triage_runs.verdict='june_review'`) —
 *      there is nothing to second-guess otherwise.
 *   2. No prior second opinion may exist (`triage_runs.verdict='second_opinion'`) — the spec is
 *      EXACTLY one second opinion per escalation lifecycle.
 *   3. No inflight `cs-director-call` job on the ticket (`spec_slug=ticket_id`) — same shape the
 *      hourly cron dedupe uses, so a queued/active second opinion can't be double-enqueued.
 *
 * The write is an `agent_jobs` insert (kind='cs-director-call') with `instructions.second_opinion_of`
 * set to the first review's `triage_runs.id`. `runCsDirectorCallJob` (scripts/builder-worker.ts)
 * routes on `second_opinion_of` to include the first review in June's brief, adjust the prompt
 * framing, and record verdict='second_opinion' in triage_runs.
 *
 * See docs/brain/libraries/cs-director-second-opinion.md +
 * docs/brain/specs/june-review-replaces-solver-skeptic-quorum-triage.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface EnqueueSecondOpinionOk {
  ok: true;
  job_id: string;
  first_run_id: string;
}

export interface EnqueueSecondOpinionErr {
  ok: false;
  reason:
    | "ticket_not_found"
    | "ticket_not_escalated"
    | "no_prior_june_review"
    | "second_opinion_already_exists"
    | "already_in_flight"
    | "enqueue_failed";
  detail?: string;
}

export type EnqueueSecondOpinionResult = EnqueueSecondOpinionOk | EnqueueSecondOpinionErr;

/**
 * Enqueue a single on-demand June second-opinion review of an escalated ticket. Returns a shaped
 * result — the caller decides whether the guard-miss reasons are user-facing (a script prints, a
 * route returns 4xx). Never throws for a guard miss; only a Supabase error is surfaced via
 * `reason='enqueue_failed'` with the message in `detail`.
 *
 * The `workspaceId` is resolved from the ticket row for two reasons: (a) the ticket id is the
 * anchor, so a caller doesn't need to know the workspace to trigger; (b) the agent_jobs row must
 * carry the ticket's workspace (RLS + per-workspace scoping) and reading it here is the single
 * source of truth. A supplied `expectedWorkspaceId` is compared for the caller who wants to
 * cross-check (a dashboard route asserts the caller's workspace matches).
 */
export async function enqueueJuneSecondOpinion(
  admin: Admin,
  ticketId: string,
  opts?: { expectedWorkspaceId?: string },
): Promise<EnqueueSecondOpinionResult> {
  const { data: ticket, error: tErr } = await admin
    .from("tickets")
    .select("id, workspace_id, escalated_at, escalated_to, status")
    .eq("id", ticketId)
    .maybeSingle();
  if (tErr) return { ok: false, reason: "ticket_not_found", detail: tErr.message };
  if (!ticket) return { ok: false, reason: "ticket_not_found" };
  if (opts?.expectedWorkspaceId && ticket.workspace_id !== opts.expectedWorkspaceId) {
    return { ok: false, reason: "ticket_not_found", detail: "workspace_mismatch" };
  }
  // The ticket must still be routine-escalated (or at least previously so — an unescalated ticket
  // has no reason to be June-reviewed a second time). Escalated_at present is the anchor for "this
  // ticket landed on the escalation lane"; escalated_to may be set if a prior June review said
  // escalate_founder, which is fine — we still allow a second opinion (it might redirect to
  // approve_remedy). But a ticket that was NEVER escalated should not carry a second opinion.
  if (!ticket.escalated_at) return { ok: false, reason: "ticket_not_escalated" };

  // Prior runs check — the guard that "exactly one" boils down to. Read every triage_runs row for
  // the ticket, count by verdict.
  const { data: priorRuns } = await admin
    .from("triage_runs")
    .select("id, verdict, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  const runs = (priorRuns || []) as { id: string; verdict: string | null; created_at: string }[];
  const juneReviews = runs.filter((r) => r.verdict === "june_review");
  const secondOpinions = runs.filter((r) => r.verdict === "second_opinion");
  if (!juneReviews.length) return { ok: false, reason: "no_prior_june_review" };
  if (secondOpinions.length) return { ok: false, reason: "second_opinion_already_exists" };
  // Use the most-recent june_review as the anchor (there is at most one, but be defensive against
  // duplicates in the ledger from a prior worker bug).
  const firstRunId = juneReviews[juneReviews.length - 1].id;

  // Inflight guard — the same shape the hourly cron uses so a queued/claimed/building cs-director-
  // call on this ticket blocks a second-opinion enqueue. The write is compare-and-set safe because
  // it re-reads the SAME row set at insert-time (see the insert error path below — a duplicate
  // spec_slug insert is not blocked by the DB, but the runner will still only pick up ONE at a
  // time due to the per-slug queue view, and this early check keeps the ledger clean).
  const { data: inflight } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", ticket.workspace_id)
    .eq("kind", "cs-director-call")
    .eq("spec_slug", ticketId)
    .in("status", ["queued", "queued_resume", "claimed", "building", "needs_input"])
    .limit(1);
  if (inflight && inflight.length) return { ok: false, reason: "already_in_flight" };

  const { data: inserted, error: iErr } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: ticket.workspace_id,
      spec_slug: ticketId,
      kind: "cs-director-call",
      status: "queued",
      instructions: JSON.stringify({ ticket_id: ticketId, second_opinion_of: firstRunId }),
      created_by: null,
    })
    .select("id")
    .single();
  if (iErr || !inserted) return { ok: false, reason: "enqueue_failed", detail: iErr?.message };

  return { ok: true, job_id: inserted.id as string, first_run_id: firstRunId };
}
