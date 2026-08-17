/**
 * escalation-recheck — the typed, machine-checkable "what would retire this card" descriptor a
 * condition-based escalation carries alongside its human-readable body.
 *
 * Phase 1 of `an-escalation-retires-itself-when-the-condition-it-reported-self-heals`. The raise
 * paths (`escalateDiagnosisToCeo` + siblings in [[agents/platform-director]], and the pure card
 * builders [[cs-director-escalate-founder-card]] / [[assisted-purchase-failure-card]]) accept an
 * optional `retireWhen` argument and persist it on the notification row's `metadata.retire_when`
 * jsonb slot. Phase 2 — a standing sweep — reads that descriptor back and retires the card when
 * the condition proves healed. The persisted key is snake_case (`retire_when`) to match the rest
 * of the `dashboard_notifications.metadata` jsonb convention (`escalation_kind`, `dedupe_key`, …).
 *
 * DESIGN
 *
 * - CLOSED SET of typed shapes (`{ kind, params }`), NOT free text — the sweep must execute the
 *   descriptor, not interpret prose. Mirrors [[spec-phase-checks-table]]'s `{exec_kind, params}` for
 *   spec verification checks: the same shape principle keeps the sweep's execution surface small
 *   and unit-testable.
 *
 * - ABSENCE defaults to NON-RETIRABLE. `readEscalationRecheckDescriptor(metadata)` returns `null`
 *   when the row carries no descriptor or a malformed one; `isRetirable(null)` is `false`. That is
 *   the fail-closed contract the spec pins ("an un-migrated or unfamiliar raiser can never have
 *   its card auto-cleared") — a raiser that has not been taught the descriptor cannot accidentally
 *   opt into auto-retirement by forgetting the field.
 *
 * - EXPLICIT non-retirable is a first-class shape. A decision-class escalation (a founder yes/no,
 *   e.g. a storefront-campaign proposal) records `{ kind: 'non_retirable', reason }` so the sweep
 *   sees "the raiser was TAUGHT the descriptor and chose non-retirable" distinct from "the raiser
 *   forgot to set one." The behavior is identical (leave alone); the audit story is different.
 *
 * The single load-bearing constant `RETIRE_WHEN_METADATA_KEY` is the persisted jsonb key name
 * (`'retire_when'`) — every raise-path insert routes its descriptor through this constant so a
 * future rename touches ONE line, and the Phase-2 sweep reads via `readEscalationRecheckDescriptor`
 * which uses the same constant. Never spell the key inline.
 *
 * SHAPES the sweep executes (Phase 2 — this module defines the schema; the sweep is separate):
 *
 *   - `ticket_terminal`: retire when the linked ticket reached `status='closed'` and is not
 *     escalated. The 2026-08-14 pair (cards `a5376176` + `6c8ef178`, ticket `2c49bc7e` closed
 *     resolved at 05:57:41 on 08-15) is the ground-truth case this shape targets.
 *
 *   - `job_terminal`: retire when the parked `agent_jobs` row is no longer in a live /
 *     needs-attention status. For a card that fronts a parked job (a build stuck, a groom
 *     unsure) — once the job left needs_attention (completed, escorted, force-cleared), the
 *     card describes state that no longer exists.
 *
 *   - `action_satisfied`: retire when the thing the failed action was trying to create now
 *     exists — the assisted-purchase-failure case (customer has an active subscription for
 *     `create_subscription`, or an order for `create_order`).
 *
 *   - `non_retirable`: never retire (decision-class).
 *
 * Add another shape ONLY when a real card needs one; the sweep's execution surface should stay
 * exactly the set of things the inbox actually raises.
 */

/**
 * The persisted jsonb key on `dashboard_notifications.metadata`. Snake_case to match the sibling
 * metadata keys (`escalation_kind`, `dedupe_key`, `agent_job_id`, …). The Phase-1 raise paths
 * write via this constant; the Phase-2 sweep reads via `readEscalationRecheckDescriptor` (below),
 * which also uses this constant — never spell the key inline.
 */
export const RETIRE_WHEN_METADATA_KEY = "retire_when" as const;

/** All descriptor kinds — closed union. */
export type EscalationRecheckKind =
  | "ticket_terminal"
  | "job_terminal"
  | "action_satisfied"
  | "non_retirable";

/**
 * The action the sweep looks for existence of on `action_satisfied`. Named specifically per the
 * inbox's failure classes, NOT a generic "any object" — the sweep needs a concrete query per kind
 * (a subscription check is not an order check). Add a kind only when a card needs one.
 */
export type ActionSatisfiedKind = "subscription_exists" | "order_exists";

export interface TicketTerminalRecheck {
  kind: "ticket_terminal";
  ticket_id: string;
}

export interface JobTerminalRecheck {
  kind: "job_terminal";
  agent_job_id: string;
}

export interface ActionSatisfiedRecheck {
  kind: "action_satisfied";
  action: ActionSatisfiedKind;
  /** The customer the action was trying to act on — subscription/order existence is per-customer. */
  customer_id: string;
}

export interface NonRetirableRecheck {
  kind: "non_retirable";
  /** Human short reason — surfaced in the audit trail so a reader sees WHY this card cannot heal. */
  reason: string;
}

export type EscalationRecheckDescriptor =
  | TicketTerminalRecheck
  | JobTerminalRecheck
  | ActionSatisfiedRecheck
  | NonRetirableRecheck;

/** Result shape shared with other validators in the codebase (spec-phase-checks-table). */
export type EscalationRecheckValidation =
  | { valid: true; value: EscalationRecheckDescriptor }
  | { valid: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireNonEmptyString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Validate an arbitrary jsonb value against the closed descriptor union. On a malformed or unknown
 * shape returns `{ valid:false, reason }` so the caller can log WHY it was rejected — the raise
 * path uses this at write time, and the sweep re-uses it at read time so a corrupted-in-flight
 * descriptor never proceeds to execution.
 *
 * `null` / `undefined` / non-object inputs reject explicitly (they are not silently "no
 * descriptor" — that shape is only distinguished by `readEscalationRecheckDescriptor` looking up
 * `metadata.recheck`; here we are validating a value the caller believes IS a descriptor).
 */
export function validateEscalationRecheckDescriptor(input: unknown): EscalationRecheckValidation {
  if (!isRecord(input)) {
    return { valid: false, reason: "recheck must be an object with { kind, ... }" };
  }
  const kind = input["kind"];
  if (typeof kind !== "string") {
    return { valid: false, reason: "recheck.kind must be a string" };
  }
  switch (kind) {
    case "ticket_terminal": {
      const ticketId = requireNonEmptyString(input, "ticket_id");
      if (!ticketId) {
        return { valid: false, reason: "ticket_terminal.ticket_id must be a non-empty string" };
      }
      return { valid: true, value: { kind: "ticket_terminal", ticket_id: ticketId } };
    }
    case "job_terminal": {
      const jobId = requireNonEmptyString(input, "agent_job_id");
      if (!jobId) {
        return { valid: false, reason: "job_terminal.agent_job_id must be a non-empty string" };
      }
      return { valid: true, value: { kind: "job_terminal", agent_job_id: jobId } };
    }
    case "action_satisfied": {
      const action = input["action"];
      if (action !== "subscription_exists" && action !== "order_exists") {
        return {
          valid: false,
          reason: "action_satisfied.action must be 'subscription_exists' or 'order_exists'",
        };
      }
      const customerId = requireNonEmptyString(input, "customer_id");
      if (!customerId) {
        return { valid: false, reason: "action_satisfied.customer_id must be a non-empty string" };
      }
      return {
        valid: true,
        value: { kind: "action_satisfied", action, customer_id: customerId },
      };
    }
    case "non_retirable": {
      const reason = requireNonEmptyString(input, "reason");
      if (!reason) {
        return {
          valid: false,
          reason: "non_retirable.reason must be a non-empty string (decision-class rationale)",
        };
      }
      return { valid: true, value: { kind: "non_retirable", reason } };
    }
    default:
      return { valid: false, reason: `unknown recheck.kind: '${kind}'` };
  }
}

/**
 * Read the descriptor from a `dashboard_notifications.metadata` jsonb value. Returns `null` when
 * the row carries no descriptor OR its descriptor is malformed — the sweep must treat both as
 * NON-RETIRABLE (fail-closed). The reader accepts the whole metadata object so callers can pass
 * `notif.metadata` verbatim without extracting the sub-key themselves.
 *
 * Malformed descriptors do NOT throw — a corrupted jsonb value must not crash the sweep over the
 * whole inbox. The caller may `console.warn` the rejection reason via
 * `validateEscalationRecheckDescriptor` directly when it wants to log; the reader is silent.
 */
export function readEscalationRecheckDescriptor(
  metadata: unknown,
): EscalationRecheckDescriptor | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata[RETIRE_WHEN_METADATA_KEY];
  if (raw === undefined || raw === null) return null;
  const v = validateEscalationRecheckDescriptor(raw);
  return v.valid ? v.value : null;
}

/**
 * Fail-closed helper for the sweep: `null` / `non_retirable` → false; any other well-formed
 * descriptor → true. Same "absence and explicit non-retirable behave identically for the sweep"
 * rule the module doc pins.
 */
export function isRetirable(descriptor: EscalationRecheckDescriptor | null): boolean {
  if (!descriptor) return false;
  if (descriptor.kind === "non_retirable") return false;
  return true;
}
