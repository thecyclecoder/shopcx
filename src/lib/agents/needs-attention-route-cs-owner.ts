/**
 * needs-attention-route-cs-owner — Phase 3 of
 * [[../../../docs/brain/specs/account-linking-address-aware-confidence-graded-and-cs-searchable]].
 *
 * A parked `ticket-handle` (or `ticket-analyze`) `agent_jobs` row is a CS-owned job — the
 * `MONITORED_LOOPS` registry pins `ownerFunctionForKind('ticket-handle')='cs'` and
 * `ownerFunctionForKind('ticket-analyze')='cs'`. When one of those parks in `needs_attention`,
 * the existing [[needs-attention-route]] sweep would fall through to the Platform director's
 * backstop — which after 60 min surfaces the park to the CEO with a "Parked > 70 min: {kind}"
 * card, attributing the escalation to Platform (Ada). That skips the owner-director gate the
 * north-star pattern (CEO → role agent → tool, [[../operational-rules]] § North star) requires:
 * a CS-owned park must reach the CS Director (June) BEFORE the CEO fail-safe.
 *
 * This module is the smallest change that closes the gap:
 *
 *  - `decideCsOwnerRoute(row)` — pure predicate that inspects a `ParkedRowLike` and decides
 *    whether it routes to CS. Returns `{ route_to: 'cs', ticket_id, reason }` for a CS-owned
 *    kind with a resolvable ticket_id (from `instructions` JSON, or the `ticket-handle-<slice>`
 *    spec_slug pattern as a fallback), and `{ route_to: null, reason }` for everything else.
 *    No DB access — unit-testable with a plain row shape.
 *
 *  - `applyCsOwnerRoute(admin, row, decision)` — deterministic applier that:
 *      1. Guards against re-entry (an inflight `cs-director-call` on the ticket → skip; the
 *         parked row stays put for the next sweep once June's review lands).
 *      2. Enqueues a `cs-director-call` job (spec_slug=ticket_id, instructions.ticket_id) so
 *         June rules on the ticket the same way she rules on an escalated one.
 *      3. Records a `director_activity` row with `director_function='cs'` so the approvals
 *         feed attributes the escalation to the owner function ([[../approvals-feed]] uses the
 *         ledger's function to render `raisedBy`), not to Platform.
 *      4. Compare-and-set flips the parked row to `status='completed'` with a
 *         `routed_cs_owner` class marker — same shape [[needs-attention-route]] uses on the
 *         non-spec dismiss path so the sweep's status filter excludes it next pass and the
 *         70-min invariant alarm cannot fire against a routed row (Learning #9 —
 *         re-assert the read-time predicate at the write: `.eq('status','needs_attention')`).
 *
 * The wire-in is a single call in [[needs-attention-route]] `routeNeedsAttention` before the
 * generic backstop sweep — it runs as part of the same Platform-live+autonomous gate, so no
 * new autonomy surface is introduced. Only after CS can't resolve (June's review lane pushes
 * to `escalate_founder`) does the ticket reach the CEO — the supervisor-owns-its-layer contract.
 *
 * READ / WRITE surface: `agent_jobs` (parsed instructions read; insert cs-director-call;
 * compare-and-set flip parked row), `director_activity` (audit stamp). No brain-side writes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordDirectorActivity } from "@/lib/director-activity";
import { ownerFunctionForKind } from "@/lib/agents/approval-inbox";

type Admin = SupabaseClient;

/** The exact org-chart function slug the CS director (June) sits in. Matches [[../functions/cs]]. */
export const CS_FUNCTION = "cs";

/**
 * agent_jobs kinds this Phase-3 router owns — the CS-owned box lanes whose parks the CS
 * Director must rule on before Platform's backstop reaches the CEO. Derived at read time from
 * `ownerFunctionForKind` (the registry-backed map from [[../inbox]] `KIND_TO_FUNCTION`) so a
 * future kind whose registry `owner` flips to `cs` is picked up without a code change here.
 * A kind whose owner is not `cs` returns `{route_to: null}` from `decideCsOwnerRoute` — the
 * generic sweep continues to route it.
 */
export const CS_ROUTED_MARKER = "routed_cs_owner" as const;

/** Shape [[decideCsOwnerRoute]] reads — kept minimal so it's stub-friendly in tests. */
export interface ParkedRowLike {
  id: string;
  workspace_id: string;
  kind: string;
  spec_slug: string | null;
  instructions: string | null;
  error: string | null;
  log_tail: string | null;
}

/** Decision returned by [[decideCsOwnerRoute]] — pure verdict, no side effects. */
export interface CsOwnerRouteDecision {
  route_to: "cs" | null;
  ticket_id: string | null;
  reason: string;
}

/**
 * Pure predicate — decides whether this parked row is a CS-owned park that must route to the
 * CS Director. Extracts `ticket_id` from `instructions` (the JSON payload the enqueue path
 * writes, per unified-ticket-handler `sol-first-touch-enqueue`) and falls back to the
 * `ticket-handle-<slice>` `spec_slug` shape only when instructions are absent / malformed
 * (defensive read; the runner enforces `ticket_id` for a live job).
 *
 * Returns `route_to: null` for any kind whose registry owner is not `cs`, and for any CS-owned
 * kind without a resolvable ticket_id — the parked row falls through to the generic sweep in
 * both cases (the fail-safe: never dispatch a CS route on a row the CS runner can't act on).
 */
export function decideCsOwnerRoute(row: ParkedRowLike): CsOwnerRouteDecision {
  const owner = ownerFunctionForKind(row.kind);
  if (owner !== CS_FUNCTION) {
    return { route_to: null, ticket_id: null, reason: `not_cs_owned (kind=${row.kind}, owner=${owner ?? "null"})` };
  }
  const ticketId = extractTicketIdFromRow(row);
  if (!ticketId) {
    return { route_to: null, ticket_id: null, reason: `cs_owned_but_no_ticket_id` };
  }
  return { route_to: CS_FUNCTION, ticket_id: ticketId, reason: `cs_owned_kind (${row.kind})` };
}

function extractTicketIdFromRow(row: ParkedRowLike): string | null {
  if (row.instructions) {
    try {
      const parsed = JSON.parse(row.instructions) as { ticket_id?: unknown };
      if (typeof parsed.ticket_id === "string" && parsed.ticket_id.trim().length > 0) {
        return parsed.ticket_id.trim();
      }
    } catch {
      // fall through — a malformed instructions blob is not by itself disqualifying
    }
  }
  return null;
}

/** Verdict returned by [[applyCsOwnerRoute]] — the caller uses it to append to the sweep tally. */
export type CsOwnerApplyReason =
  | "enqueued_cs_director_call"
  | "already_inflight"
  | "no_ticket_id"
  | "enqueue_failed"
  | "compare_and_set_lost"
  | "not_cs_owned";

export interface CsOwnerApplyResult {
  routed: boolean;
  cs_director_call_job_id: string | null;
  reason: CsOwnerApplyReason;
}

/**
 * Apply the CS-owner route: enqueue a `cs-director-call` job (unless already inflight on this
 * ticket), stamp a CS-attributed `director_activity` row, and compare-and-set the parked row to
 * `completed` with the `routed_cs_owner` marker so the sweep's status filter excludes it next
 * pass. Best-effort throughout — a failed enqueue leaves the row parked for the next tick, and
 * a lost compare-and-set means someone else already moved the row (no double-fire).
 */
export async function applyCsOwnerRoute(
  admin: Admin,
  row: ParkedRowLike,
  decision: CsOwnerRouteDecision,
): Promise<CsOwnerApplyResult> {
  if (decision.route_to !== CS_FUNCTION) {
    return { routed: false, cs_director_call_job_id: null, reason: "not_cs_owned" };
  }
  const ticketId = decision.ticket_id;
  if (!ticketId) {
    return { routed: false, cs_director_call_job_id: null, reason: "no_ticket_id" };
  }

  // Inflight guard — mirrors [[../cs-director-second-opinion]] `enqueueSecondOpinion`. A queued /
  // claimed / building / needs_input cs-director-call on this ticket already gives June a chance
  // to rule; a second enqueue would duplicate her work. On the next sweep, once June rules and
  // her job leaves the inflight set, this router either sees the parked row already terminal
  // (June's runner closes the ticket / re-arms the handle) or re-enters if she asked for more.
  const { data: inflight } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", row.workspace_id)
    .eq("kind", "cs-director-call")
    .eq("spec_slug", ticketId)
    .in("status", ["queued", "queued_resume", "claimed", "building", "needs_input"])
    .limit(1);
  if (inflight && inflight.length) {
    return { routed: false, cs_director_call_job_id: null, reason: "already_inflight" };
  }

  const parkedFrom = {
    kind: row.kind,
    job_id: row.id,
    reason: (row.error ?? "").slice(0, 300) || null,
    log_tail: (row.log_tail ?? "").slice(-400) || null,
  };
  const { data: inserted, error: iErr } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: row.workspace_id,
      spec_slug: ticketId,
      kind: "cs-director-call",
      status: "queued",
      instructions: JSON.stringify({ ticket_id: ticketId, parked_from: parkedFrom, second_opinion_of: null }),
      created_by: null,
    })
    .select("id")
    .single();
  if (iErr || !inserted) {
    return { routed: false, cs_director_call_job_id: null, reason: "enqueue_failed" };
  }
  const jobId = (inserted as { id: string }).id;

  // Attribute the escalation to the OWNER FUNCTION (cs), not Platform — that's the spec's
  // supervisor-owns-its-layer contract, and the approvals-feed reads this ledger to render
  // `raisedBy` on the surfaced card ([[../approvals-feed]] `persona(escalatedBy ?? …)`).
  await recordDirectorActivity(admin, {
    workspaceId: row.workspace_id,
    directorFunction: CS_FUNCTION,
    actionKind: "routed_needs_attention",
    specSlug: row.spec_slug,
    reason: `Auto-routed parked ${row.kind} ${row.id.slice(0, 8)} → cs-director-call (June/CS rules before CEO fail-safe).`,
    metadata: {
      job_id: row.id,
      target_kind: row.kind,
      action: "route_cs_owned_park",
      cs_director_call_job_id: jobId,
      ticket_id: ticketId,
      autonomous: true,
    },
  });

  // Compare-and-set: only flip a row that's still needs_attention. Learning #9 pattern — re-assert
  // the read-time predicate at the write so an async race (June's runner closing the ticket
  // between our read and this update) doesn't resurrect a row that already moved on.
  const nowIso = new Date().toISOString();
  const { error: updateErr, data: updated } = await admin
    .from("agent_jobs")
    .update({
      status: "completed",
      needs_attention_class: CS_ROUTED_MARKER,
      error: `routed_cs_owner: enqueued cs-director-call ${jobId.slice(0, 8)} — June rules before CEO`,
      updated_at: nowIso,
    })
    .eq("id", row.id)
    .eq("status", "needs_attention")
    .select("id");
  if (updateErr) {
    console.warn(`[needs-attention-route-cs-owner] compare-and-set failed for ${row.id}: ${updateErr.message}`);
    return { routed: true, cs_director_call_job_id: jobId, reason: "enqueued_cs_director_call" };
  }
  if (!updated || updated.length !== 1) {
    // The row moved under us (June's runner closed it, or a manual re-open). The cs-director-call
    // is still enqueued — that's the durable side-effect — but the parked row is no longer ours.
    return { routed: true, cs_director_call_job_id: jobId, reason: "compare_and_set_lost" };
  }
  return { routed: true, cs_director_call_job_id: jobId, reason: "enqueued_cs_director_call" };
}
