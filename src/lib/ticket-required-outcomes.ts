/**
 * ticket-required-outcomes — the SDK for the structured, individually-checkable "what" behind
 * a customer reply (see docs/brain/tables/ticket_required_outcomes.md +
 * docs/brain/libraries/ticket-required-outcomes.md).
 *
 * The message-is-last pipeline drives off these rows instead of prose:
 *   Phase 1 (this SDK) — Sol distills the customer's asks into N structured required-outcome
 *     rows, each with an `expected_db_state` predicate that would prove it done.
 *   Phase 2 — the executor honors each row (fires the action + verifies against the DB) BEFORE
 *     any reply is composed.
 *   Phase 3 — the send guard blocks any claim whose backing row isn't status='verified'.
 *   Phase 4 — the completion gate keeps the ticket in-progress until every row is verified.
 *
 * Status transitions:
 *   pending → done       (Phase 2 executor fired the action; DB verify hasn't confirmed yet)
 *   done    → verified   (Phase 2 verifyActionInDB or equivalent confirmed the predicate)
 *   pending → verified   (rare — the predicate already held at Direction-authoring time)
 *   pending → failed     (Phase 2 escalated on a guardrail or the action errored)
 *   done    → failed     (Phase 2 DB verify couldn't back the claim)
 *   failed  → waived     (completing the outcome is policy-forbidden against live state — e.g.
 *                         a coupon apply onto a paused sub — so the row is closed as
 *                         correctly-NOT-done instead of re-firing; see [[required-outcome-policy]])
 *   pending → waived     (same, caught before the executor ever fired)
 *
 * `verified` and `waived` are the two TERMINAL-CLOSED statuses — the completion gate opens on
 * either (a verified outcome happened; a waived outcome correctly did not). Only pending/done/
 * failed keep the ticket open.
 *
 * Every mutating call is a compare-and-set on the current status (learning #5 — re-assert the
 * read-time predicate in the write, never trust a proxy) so a racing writer can't overwrite
 * a fresher terminal state with a stale one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export type RequiredOutcomeStatus = "pending" | "done" | "verified" | "failed" | "waived";

/** The two terminal-closed statuses — the completion gate opens on either. */
export const CLOSED_OUTCOME_STATUSES: ReadonlySet<RequiredOutcomeStatus> = new Set<RequiredOutcomeStatus>([
  "verified",
  "waived",
]);

/**
 * The DB predicate that would prove a required outcome done. Free-form jsonb — Phase 2 defines
 * how the executor consumes it. A common shape is
 *   {"table":"subscriptions","match":{"shopify_contract_id":"gid://..."},"column":"status","expected":"paused"}
 * but the field is intentionally loose: some outcomes will read multiple columns, some will
 * check a count-of-rows, some will call a helper. What matters at authoring time is that the
 * item's author records the shape of the proof — not just prose.
 */
export type ExpectedDbState = Record<string, unknown>;

export interface TicketRequiredOutcome {
  id: string;
  workspace_id: string;
  ticket_id: string;
  direction_id: string | null;
  kind: string;
  description: string;
  target_ids: Record<string, unknown>;
  expected_db_state: ExpectedDbState;
  status: RequiredOutcomeStatus;
  resolution_event_id: string | null;
  verified_at: string | null;
  failed_reason: string | null;
  authored_by: string;
  authored_at: string;
}

export interface RequiredOutcomeInput {
  kind: string;
  description: string;
  target_ids?: Record<string, unknown>;
  expected_db_state?: ExpectedDbState;
}

const COLS =
  "id, workspace_id, ticket_id, direction_id, kind, description, target_ids, expected_db_state, status, resolution_event_id, verified_at, failed_reason, authored_by, authored_at";

/**
 * Batch-insert the N required outcomes distilled from a ticket. Returns the inserted rows in
 * authored order. Every item is a distinct row — this SDK never packs multiple outcomes into a
 * single jsonb blob (the whole point is that each item is INDIVIDUALLY CHECKABLE by the Phase-2
 * executor and the Phase-3 send guard).
 *
 * Scoped by `workspace_id` on the insert so a cross-workspace ticket-id collision can't route
 * a Direction's outcomes to the wrong tenant.
 */
export async function writeRequiredOutcomes(
  admin: Admin,
  input: {
    workspace_id: string;
    ticket_id: string;
    direction_id?: string | null;
    items: RequiredOutcomeInput[];
    authored_by?: string;
  },
): Promise<TicketRequiredOutcome[]> {
  if (input.items.length === 0) return [];
  const rows = input.items.map((it) => ({
    workspace_id: input.workspace_id,
    ticket_id: input.ticket_id,
    direction_id: input.direction_id ?? null,
    kind: it.kind,
    description: it.description,
    target_ids: it.target_ids ?? {},
    expected_db_state: it.expected_db_state ?? {},
    authored_by: input.authored_by ?? "sol_box_session",
  }));
  const { data, error } = await admin
    .from("ticket_required_outcomes")
    .insert(rows)
    .select(COLS);
  if (error) throw error;
  return (data ?? []) as TicketRequiredOutcome[];
}

/**
 * List every required outcome for a ticket in authored order. The Phase-2 executor walks this
 * list; the Phase-3 send guard reads it to answer "is this claim backed by a verified row?"; the
 * Phase-4 completion gate reads it to answer "are we done?".
 */
export async function listRequiredOutcomes(
  admin: Admin,
  ticket_id: string,
  opts?: { workspace_id?: string },
): Promise<TicketRequiredOutcome[]> {
  let q = admin
    .from("ticket_required_outcomes")
    .select(COLS)
    .eq("ticket_id", ticket_id)
    .order("authored_at", { ascending: true });
  if (opts?.workspace_id) q = q.eq("workspace_id", opts.workspace_id);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as TicketRequiredOutcome[];
}

/**
 * Compare-and-set status transition on a single required-outcome row. `from` is the status the
 * caller expects to be current — the update includes `.eq('status', from)` so a racing writer
 * that already moved the row to a fresher terminal state can't be overwritten (learning #5).
 * Returns the updated row, or `null` when the CAS lost (the caller can re-read the row and
 * decide how to react instead of silently clobbering).
 */
async function transitionStatus(
  admin: Admin,
  input: {
    id: string;
    workspace_id: string;
    from: RequiredOutcomeStatus;
    to: RequiredOutcomeStatus;
    resolution_event_id?: string | null;
    failed_reason?: string | null;
    stamp_verified_at?: boolean;
  },
): Promise<TicketRequiredOutcome | null> {
  const patch: Record<string, unknown> = { status: input.to };
  if (input.resolution_event_id !== undefined) {
    patch.resolution_event_id = input.resolution_event_id;
  }
  if (input.failed_reason !== undefined) {
    patch.failed_reason = input.failed_reason;
  }
  if (input.stamp_verified_at) {
    patch.verified_at = new Date().toISOString();
  }
  const { data, error } = await admin
    .from("ticket_required_outcomes")
    .update(patch)
    .eq("id", input.id)
    .eq("workspace_id", input.workspace_id)
    .eq("status", input.from)
    .select(COLS);
  if (error) throw error;
  const rows = (data ?? []) as TicketRequiredOutcome[];
  return rows[0] ?? null;
}

/**
 * Mark a required outcome as executed (the action fired) but not yet DB-verified. Phase 2 calls
 * this after the executor's handler returns success. CAS from 'pending'.
 */
export function markOutcomeDone(
  admin: Admin,
  input: { id: string; workspace_id: string; resolution_event_id?: string | null },
): Promise<TicketRequiredOutcome | null> {
  return transitionStatus(admin, {
    id: input.id,
    workspace_id: input.workspace_id,
    from: "pending",
    to: "done",
    resolution_event_id: input.resolution_event_id ?? null,
  });
}

/**
 * Mark a required outcome as verified — the `expected_db_state` predicate holds. Phase 2 calls
 * this after `verifyActionInDB` (or an equivalent read-back) confirms the DB is in the expected
 * state. CAS from `from` (default 'done' — the executor's normal path); pass `from: 'pending'`
 * for the rare case where the predicate already held at authoring time, or `from: 'failed'`
 * for the CS Director approve_remedy reconciliation path (a rescue action fired the same kind
 * and the live DB now backs the claim — see [[honor-required-outcomes]]
 * `reconcileRequiredOutcomesForFiredActions`).
 */
export function markOutcomeVerified(
  admin: Admin,
  input: {
    id: string;
    workspace_id: string;
    from?: "pending" | "done" | "failed";
    resolution_event_id?: string | null;
  },
): Promise<TicketRequiredOutcome | null> {
  return transitionStatus(admin, {
    id: input.id,
    workspace_id: input.workspace_id,
    from: input.from ?? "done",
    to: "verified",
    resolution_event_id: input.resolution_event_id,
    stamp_verified_at: true,
  });
}

/**
 * Mark a required outcome as failed. Phase 2 calls this when the executor escalates on a
 * guardrail or the action errors, and when the DB verify can't back a done row. The `reason` is
 * stored on `failed_reason` so the Phase-4 escalation can name what fell over. CAS from `from`
 * (default 'pending'); pass `from: 'done'` for the verify-failed path.
 */
export function markOutcomeFailed(
  admin: Admin,
  input: {
    id: string;
    workspace_id: string;
    from?: "pending" | "done";
    reason: string;
    resolution_event_id?: string | null;
  },
): Promise<TicketRequiredOutcome | null> {
  return transitionStatus(admin, {
    id: input.id,
    workspace_id: input.workspace_id,
    from: input.from ?? "pending",
    to: "failed",
    failed_reason: input.reason,
    resolution_event_id: input.resolution_event_id,
  });
}

/**
 * Mark a required outcome as WAIVED — completing it is policy-forbidden against live DB state, so
 * the row is closed as correctly-NOT-done rather than left in `failed` to re-escalate forever.
 * The ground-truth case: an `apply_loyalty_coupon` outcome authored against a paused subscription
 * (ticket aaf00047) — the active loyalty rule forbids it and the handler fails it upstream with
 * `subscription_not_active`, so no rescue action can ever clear the failed row. The waive path
 * (driven by the completion gate's `waivePolicyForbiddenOutcomes`, gated on the shared
 * `assessPolicyForbidden` predicate in [[required-outcome-policy]]) stops the loop.
 *
 * The `reason` is stored on `failed_reason` (the row's generic reason field) so dashboards can
 * render why it was waived. CAS from `from` (default 'failed' — the common stuck state); pass
 * `from: 'pending'` for a row caught before the executor fired. NEVER waives a 'done'/'verified'
 * row — those outcomes actually happened. Returns null when the CAS lost (a racing writer already
 * progressed the row).
 */
export function markOutcomeWaived(
  admin: Admin,
  input: {
    id: string;
    workspace_id: string;
    from?: "pending" | "failed";
    reason: string;
  },
): Promise<TicketRequiredOutcome | null> {
  return transitionStatus(admin, {
    id: input.id,
    workspace_id: input.workspace_id,
    from: input.from ?? "failed",
    to: "waived",
    failed_reason: input.reason,
  });
}

/**
 * "Are any required outcomes still open?" — the Phase-4 completion gate's core predicate.
 * Returns `true` when at least one row has status in {pending, done, failed}: pending means the
 * executor hasn't fired the action yet, done means it fired but the DB verify hasn't confirmed,
 * failed means an action or verify blew up and escalates to June. Both 'verified' and 'waived'
 * count as closed — a waived row is a correctly-NOT-done outcome (policy-forbidden; see
 * [[required-outcome-policy]]) and must NOT keep the ticket open.
 *
 * Backed by the partial index `WHERE status NOT IN ('verified','waived')` — the gate check stays
 * cheap even when the ticket has dozens of already-closed rows.
 */
export async function hasUnverifiedOutcomes(
  admin: Admin,
  ticket_id: string,
  workspace_id: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("ticket_required_outcomes")
    .select("id")
    .eq("workspace_id", workspace_id)
    .eq("ticket_id", ticket_id)
    .neq("status", "verified")
    .neq("status", "waived")
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Count required outcomes by status for a ticket — used by the Phase-4 completion gate's
 * escalation message ("2 pending, 1 failed") and by dashboards.
 */
export async function countOutcomesByStatus(
  admin: Admin,
  ticket_id: string,
  workspace_id: string,
): Promise<Record<RequiredOutcomeStatus, number>> {
  const { data, error } = await admin
    .from("ticket_required_outcomes")
    .select("status")
    .eq("workspace_id", workspace_id)
    .eq("ticket_id", ticket_id);
  if (error) throw error;
  const counts: Record<RequiredOutcomeStatus, number> = {
    pending: 0,
    done: 0,
    verified: 0,
    failed: 0,
    waived: 0,
  };
  for (const row of (data ?? []) as Array<{ status: RequiredOutcomeStatus }>) {
    counts[row.status] += 1;
  }
  return counts;
}
