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
import { resolveNodeOwner } from "@/lib/control-tower/node-registry";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";

type Admin = SupabaseClient;

/** The exact org-chart function slug the CS director (June) sits in. Matches [[../functions/cs]]. */
export const CS_FUNCTION = "cs";

/**
 * Loop-guard (Phase 1 of cs-director-call-loop-guard-and-message-only-remedy) — cap how many times a
 * single ticket may be handed to June via this router in a rolling window. Past the cap, DO NOT
 * re-enqueue another `cs-director-call`: raise ONE founder escalation instead, so a director who is
 * structurally unable to finish stops being re-asked forever (ticket 86043da0 burned 69 calls in 11
 * days). Env-overridable; default 3 mirrors `MARIO_LOOP_GUARD_DEFAULT_MAX` in [[../mario]] and
 * `DEPLOY_GUARDIAN_LOOP_GUARD_MAX` in [[../deploy-guardian]]. Same shape as both siblings.
 */
export const CS_DIRECTOR_LOOP_GUARD_MAX = Number(process.env.CS_DIRECTOR_LOOP_GUARD_MAX || 3);
/** Rolling window the loop-guard counts prior calls over — 24h, mirroring both sibling guards. */
const CS_DIRECTOR_LOOP_GUARD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * agent_jobs kinds this Phase-3 router owns — the CS-owned box lanes whose parks the CS
 * Director must rule on before Platform's backstop reaches the CEO. Derived at read time from
 * the canonical `resolveNodeOwner` ([[../control-tower/node-registry]]) so a future kind whose
 * registry `owner` flips to `cs` is picked up without a code change here.
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
  const owner = resolveNodeOwner(row.kind);
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
  | "not_cs_owned"
  | "loop_guard_tripped";

/**
 * Count prior `cs_director_call` `director_activity` rows for THIS ticket in the last
 * `CS_DIRECTOR_LOOP_GUARD_WINDOW_MS`. Same shape as `priorRollbacksForSlug` in [[../deploy-guardian]]
 * and `countPriorMarioFixesForSlug` in [[../mario]] — an `exact/head:true` count read so we get the
 * number without pulling row bodies. Filters on `metadata->>ticket_id` (that's where the runner
 * stamps the ticket, per `scripts/builder-worker.ts` § runCsDirectorCallJob), NOT on `spec_slug`
 * (which becomes the authored spec's slug when June writes a spec, so `.eq('spec_slug', ticketId)`
 * would silently under-count on any spec-authoring outcome).
 */
export async function countPriorCsDirectorCallsForTicket(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
): Promise<number> {
  const sinceIso = new Date(Date.now() - CS_DIRECTOR_LOOP_GUARD_WINDOW_MS).toISOString();
  const { count } = await admin
    .from("director_activity")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("director_function", CS_FUNCTION)
    .eq("action_kind", "cs_director_call")
    .eq("metadata->>ticket_id", ticketId)
    .gte("created_at", sinceIso);
  return count ?? 0;
}

/**
 * Latest cs_director_call reasoning for this ticket in the loop-guard window — surfaced verbatim on
 * the founder escalation so the CEO sees WHY June is stuck, not just that she is (per spec Phase 1).
 * Returns null when no prior row exists (the loop-guard branch is only reachable when count ≥ MAX,
 * so this is effectively always non-null there — but null-safe for readability + tests).
 */
export async function latestCsDirectorReasonForTicket(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
): Promise<string | null> {
  const sinceIso = new Date(Date.now() - CS_DIRECTOR_LOOP_GUARD_WINDOW_MS).toISOString();
  const { data } = await admin
    .from("director_activity")
    .select("reason, created_at")
    .eq("workspace_id", workspaceId)
    .eq("director_function", CS_FUNCTION)
    .eq("action_kind", "cs_director_call")
    .eq("metadata->>ticket_id", ticketId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = Array.isArray(data) && data.length ? (data[0] as { reason: string | null }) : null;
  return row?.reason?.trim() || null;
}

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

  // Loop-guard (Phase 1 of cs-director-call-loop-guard-and-message-only-remedy) — count how many
  // times June has ALREADY been called on this ticket in the rolling window. At/above the cap,
  // stop re-asking and raise ONE founder escalation whose reason names the loop explicitly + carries
  // June's latest reasoning verbatim so the CEO sees WHY she is stuck. Mirrors the shape both
  // sibling loop-guards use: `priorRollbacksForSlug` in [[../deploy-guardian]] (checked at
  // deploy-guardian.ts:824) and `countPriorMarioFixesForSlug` in [[../mario]] (checked at
  // mario.ts:2937). The inflight guard below still runs so the current in-flight call is not
  // interrupted; the loop-guard is a NEW-enqueue precondition.
  //
  // The escalation is idempotent per ticket via `escalateDiagnosisToCeo` (its
  // `bumpOpenEscalationCard` upsert — one open card per dedupe_key, not one card per suppressed
  // attempt, per [[platform-director]] one-open-escalation-per-thing Phase 1). And the parked row
  // is still moved terminal (`routed_cs_owner`) so the sweep's status filter excludes it next pass
  // and the 70-min invariant alarm cannot fire against a loop-guarded row.
  const priorCalls = await countPriorCsDirectorCallsForTicket(admin, row.workspace_id, ticketId);
  if (priorCalls >= CS_DIRECTOR_LOOP_GUARD_MAX) {
    const juneReason = await latestCsDirectorReasonForTicket(admin, row.workspace_id, ticketId);
    const truncatedJuneReason = juneReason ? juneReason.slice(0, 1500) : null;
    const diagnosis = `June has been called ${priorCalls} times on ticket ${ticketId.slice(0, 8)} in the last ${Math.round(
      CS_DIRECTOR_LOOP_GUARD_WINDOW_MS / (60 * 60 * 1000),
    )}h and cannot resolve it (CS_DIRECTOR_LOOP_GUARD_MAX=${CS_DIRECTOR_LOOP_GUARD_MAX}). Auto-routing this ticket to another cs-director-call is now SUPPRESSED; the customer is likely still waiting and needs a human to unblock the class June kept hitting.${
      truncatedJuneReason ? ` Latest June reasoning: ${truncatedJuneReason}` : ""
    }`;
    try {
      await escalateDiagnosisToCeo(admin, {
        workspaceId: row.workspace_id,
        specSlug: null,
        title: `CS director loop: ticket ${ticketId.slice(0, 8)} — June stuck after ${priorCalls} calls`,
        diagnosis,
        dedupeKey: `cs-director-loop-guard:${ticketId}`,
        deepLink: `/dashboard/tickets/${ticketId}`,
        escalationKind: "cs_director_loop_guard",
        metadata: {
          ticket_id: ticketId,
          parked_job_id: row.id,
          parked_kind: row.kind,
          prior_calls: priorCalls,
          loop_guard_max: CS_DIRECTOR_LOOP_GUARD_MAX,
          window_ms: CS_DIRECTOR_LOOP_GUARD_WINDOW_MS,
        },
      });
    } catch (e) {
      console.warn(
        `[needs-attention-route-cs-owner] loop-guard escalation failed for ticket ${ticketId}:`,
        e instanceof Error ? e.message : e,
      );
    }
    // Ledger the loop-guard trip on `director_activity` so a grader / audit reader can trace the
    // suppressed enqueue without re-parsing the CEO card. Mirrors the `mario_loop_guard` row Mario
    // writes when its blocked-by-repair path trips the same 24h cap (mario.ts:2937-2957).
    await recordDirectorActivity(admin, {
      workspaceId: row.workspace_id,
      directorFunction: CS_FUNCTION,
      actionKind: "cs_director_loop_guard",
      specSlug: row.spec_slug,
      reason: diagnosis.slice(0, 4000),
      metadata: {
        job_id: row.id,
        target_kind: row.kind,
        action: "cs_director_loop_guard",
        ticket_id: ticketId,
        prior_calls: priorCalls,
        loop_guard_max: CS_DIRECTOR_LOOP_GUARD_MAX,
        window_ms: CS_DIRECTOR_LOOP_GUARD_WINDOW_MS,
        autonomous: true,
      },
    });
    // Move the parked row terminal with the routed marker so the sweep's status filter excludes it
    // next pass (same shape the enqueue-success branch uses below — Learning #9: re-assert the
    // read-time predicate at the write). Without this the same parked row would surface next tick
    // and re-count, re-escalating (though the dedupe would still hold — the ledger just gets noisy).
    const { data: updated, error: updateErr } = await admin
      .from("agent_jobs")
      .update({
        status: "completed",
        needs_attention_class: CS_ROUTED_MARKER,
        error: `cs_director_loop_guard: ${priorCalls} prior calls ≥ CS_DIRECTOR_LOOP_GUARD_MAX=${CS_DIRECTOR_LOOP_GUARD_MAX}; escalated to CEO`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "needs_attention")
      .select("id");
    if (updateErr) {
      console.warn(`[needs-attention-route-cs-owner] loop-guard compare-and-set failed for ${row.id}: ${updateErr.message}`);
    } else if (!updated || updated.length !== 1) {
      // Row moved under us — no harm; the escalation is still up.
    }
    return { routed: false, cs_director_call_job_id: null, reason: "loop_guard_tripped" };
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
