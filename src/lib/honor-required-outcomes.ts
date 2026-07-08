/**
 * honor-required-outcomes — Phase 2 of docs/brain/specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified.md.
 *
 * The middle step of the message-is-last pipeline:
 *   Phase 1 (already shipped) — Sol distills the customer's asks into structured
 *     ticket_required_outcomes rows.
 *   Phase 2 (this file) — the honor step walks pending items, fires each action via the existing
 *     directActionHandlers dispatch, verifies against the DB via verifyActionInDB, and marks each
 *     item verified or failed. Actions run to completion (or fail loudly) FIRST — no customer
 *     message is composed while any item is still pending. A `replyGateBlocked` predicate reports
 *     whether reply composition can proceed.
 *   Phase 3 — the customer-facing send guard (extending sol-policy-bait-guard) uses
 *     replyGateBlocked at every reply-drafting site so an unbacked claim is blocked and rewritten.
 *   Phase 4 — the completion gate keeps the ticket in-progress until all outcomes verify.
 *
 * Design: the top-level `honorRequiredOutcomes` is the wire-in point (real DB + real dispatchers).
 * Two smaller primitives — `decideOutcome` and `replyGateBlocked` — carry the actual logic and
 * are pure enough to test with node:test + injected fakes, so the "actions run BEFORE the reply
 * gate ever passes" ordering invariant is provably true without spinning up Supabase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionParams, ActionContext, ActionResult } from "./action-executor";
import { directActionHandlers, verifyActionInDB } from "./action-executor";
import {
  listRequiredOutcomes,
  markOutcomeDone,
  markOutcomeVerified,
  markOutcomeFailed,
  type TicketRequiredOutcome,
} from "./ticket-required-outcomes";

/** The subset of {@link ActionContext} the honor step needs to synthesize a real ActionContext. */
export interface HonorContext {
  admin: SupabaseClient;
  workspace_id: string;
  ticket_id: string;
  customer_id: string;
  channel: string;
  /**
   * Sandbox mode (per {@link ActionContext.sandbox}). The honor step passes this through to the
   * real handlers unchanged — sandbox=true means vendor calls are dry-runs, so a Phase-2 rehearsal
   * against a probe ticket doesn't touch the customer's real subscription.
   */
  sandbox: boolean;
  /**
   * When true, an already-verified item is left alone (skipped_already_verified is incremented).
   * When false, we still assert its verify predicate holds and mark it failed if it doesn't. The
   * default `true` matches the normal wire-in shape — reverification is a diagnostic mode.
   */
  respect_existing_verified?: boolean;
}

/** One decision the honor step made on a single outcome. */
export interface OutcomeHonorResult {
  outcome_id: string;
  kind: string;
  description: string;
  /** `verified` means the DB predicate held (or was made to hold by the handler + verify pair). */
  final_status: "verified" | "failed";
  /** Populated when final_status='failed' — the exact reason surfaced to the Phase-4 escalation. */
  failed_reason?: string;
}

/** Rollup of one honor pass — what {@link honorRequiredOutcomes} returns to the caller. */
export interface HonorSummary {
  /** Every outcome the honor step attempted this pass (excludes items skipped from the outset). */
  attempted: OutcomeHonorResult[];
  /** true iff every attempted item ended in `verified` AND no prior-failed items were carried forward. */
  all_verified: boolean;
  /** Subset of `attempted` where `final_status='failed'`. */
  failed_items: OutcomeHonorResult[];
  /** Count of items skipped because they were already `verified` at the start of this pass. */
  skipped_already_verified: number;
  /**
   * Items carried forward in `failed` state from a prior pass. The honor step does NOT retry a
   * failed item automatically — a failed item stops the pass (Phase-4 escalation names it). This
   * list surfaces the descriptions to the caller so the escalation can be built.
   */
  carried_forward_failed: OutcomeHonorResult[];
}

/** Per-outcome verdict produced by {@link decideOutcome}. */
export type OutcomeDecision =
  | { verdict: "verified" }
  | { verdict: "failed"; reason: string };

/**
 * Pure per-outcome decision — dispatches an action, then verifies it. `dispatch` fires the
 * customer-effect (subscription mutation, coupon, refund, …); `verify` reads the DB back to
 * confirm the expected state held. Both are injected so a test can drive each branch (handler
 * throws, handler returns success=false, verify returns false, verify throws) without touching
 * the DB or the real action handlers.
 *
 * The rule the top-level honor step enforces:
 *  1. dispatch throws  → failed (reason quotes the thrown message)
 *  2. dispatch returns success=false → failed (reason quotes the handler's `error`)
 *  3. verify throws → failed (reason quotes the thrown message)
 *  4. verify returns false → failed ('db verify did not confirm expected state')
 *  5. dispatch success + verify true → verified
 *
 * The Phase-3 send guard reads only the row's terminal `verified` status; a claim asserted on a
 * `failed`/`pending`/`done` row is blocked. This is why a failed dispatch or a bad verify BOTH
 * land as `failed` — the send guard's predicate stays a single-line comparison against
 * `status === 'verified'`.
 */
export async function decideOutcome(
  action: ActionParams,
  dispatch: (action: ActionParams) => Promise<ActionResult>,
  verify: (action: ActionParams) => Promise<boolean>,
): Promise<OutcomeDecision> {
  let handlerResult: ActionResult;
  try {
    handlerResult = await dispatch(action);
  } catch (err) {
    return { verdict: "failed", reason: `handler threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!handlerResult.success) {
    return { verdict: "failed", reason: handlerResult.error ?? "handler returned success=false" };
  }
  let verified: boolean;
  try {
    verified = await verify(action);
  } catch (err) {
    return { verdict: "failed", reason: `verify threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (verified) return { verdict: "verified" };
  return { verdict: "failed", reason: "db verify did not confirm expected state" };
}

/** The reply-gate predicate's return shape. */
export interface ReplyGateVerdict {
  /** true when a customer-facing reply MUST NOT ship yet (at least one outcome is not verified). */
  blocked: boolean;
  /** descriptions of items still pending or done (executor ran but not DB-confirmed). */
  pending: string[];
  /** descriptions of items that terminally failed — Phase-4 escalation names them verbatim. */
  failed: string[];
  /** count of items already `verified` — the number the reply can honestly claim. */
  verified_count: number;
}

/**
 * Pure predicate: given the complete outcome list for a ticket, return whether the reply-drafting
 * step is even allowed. The Phase-3 send guard calls this at every reply-drafting site (Sol box
 * reply, executeSonnetDecision, playbook/journey, Improve tab) and refuses to compose a reply
 * when `blocked===true`.
 *
 * `blocked` is true when ANY non-verified outcome exists — pending, done (executor fired, DB not
 * yet confirmed), or failed. A `done` row is deliberately NOT ship-worthy: the executor's action
 * fired but the DB predicate hasn't been confirmed, so a reply that claims that outcome is still
 * a false promise the moment it ships.
 */
export function replyGateBlocked(outcomes: TicketRequiredOutcome[]): ReplyGateVerdict {
  const pending: string[] = [];
  const failed: string[] = [];
  let verified_count = 0;
  for (const o of outcomes) {
    if (o.status === "verified") { verified_count += 1; continue; }
    if (o.status === "failed") { failed.push(o.description); continue; }
    // status is 'pending' or 'done' — executor may have fired but DB verify hasn't confirmed
    pending.push(o.description);
  }
  return { blocked: pending.length + failed.length > 0, pending, failed, verified_count };
}

/** Build an ActionParams shape from a stored outcome. `target_ids` fields are spread into the params. */
export function outcomeToActionParams(outcome: TicketRequiredOutcome): ActionParams {
  const targetIds = outcome.target_ids ?? {};
  return { type: outcome.kind, ...targetIds } as unknown as ActionParams;
}

/** Synthesize a real ActionContext the existing directActionHandlers expect. */
function toActionContext(ctx: HonorContext): ActionContext {
  return {
    admin: ctx.admin,
    workspaceId: ctx.workspace_id,
    ticketId: ctx.ticket_id,
    customerId: ctx.customer_id,
    channel: ctx.channel,
    sandbox: ctx.sandbox,
  };
}

/**
 * The top-level honor step. Runs BEFORE any customer-facing reply is composed. Walks every
 * ticket_required_outcomes row for the ticket in authored order, dispatches each pending item
 * via `directActionHandlers`, verifies via `verifyActionInDB`, and marks the row `verified` or
 * `failed`. Returns a summary the caller uses to (a) drive the Phase-4 escalation when any item
 * fails, and (b) confirm every item is verified before allowing the Phase-3 send guard to open.
 *
 * A previously-failed item is NOT retried here — the honor step surfaces it via
 * `carried_forward_failed` so the Phase-4 escalation can name it. A caller who wants to retry
 * clears the row's status manually (an admin-driven UI or a re-authored Direction) — the honor
 * step never silently retries a terminal failure.
 */
export async function honorRequiredOutcomes(ctx: HonorContext): Promise<HonorSummary> {
  const outcomes = await listRequiredOutcomes(ctx.admin, ctx.ticket_id, { workspace_id: ctx.workspace_id });
  const summary: HonorSummary = {
    attempted: [],
    all_verified: true,
    failed_items: [],
    skipped_already_verified: 0,
    carried_forward_failed: [],
  };
  const actionCtx = toActionContext(ctx);
  const respectVerified = ctx.respect_existing_verified !== false;

  for (const o of outcomes) {
    if (o.status === "verified" && respectVerified) {
      summary.skipped_already_verified += 1;
      continue;
    }
    if (o.status === "failed") {
      summary.all_verified = false;
      summary.carried_forward_failed.push({
        outcome_id: o.id,
        kind: o.kind,
        description: o.description,
        final_status: "failed",
        failed_reason: o.failed_reason ?? undefined,
      });
      continue;
    }
    // status is 'pending' or 'done' — attempt honor
    const action = outcomeToActionParams(o);
    const handler = directActionHandlers[action.type];

    let decision: OutcomeDecision;
    if (!handler) {
      decision = { verdict: "failed", reason: `unknown action type: ${action.type}` };
    } else {
      decision = await decideOutcome(
        action,
        (a) => handler(actionCtx, a),
        (a) => verifyActionInDB(actionCtx, a),
      );
    }

    if (decision.verdict === "verified") {
      // pending → done → verified. Skip the done stamp if the row was already done (executor
      // fired earlier this session and we're just re-verifying).
      if (o.status === "pending") {
        await markOutcomeDone(ctx.admin, { id: o.id, workspace_id: ctx.workspace_id });
      }
      await markOutcomeVerified(ctx.admin, { id: o.id, workspace_id: ctx.workspace_id, from: "done" });
      summary.attempted.push({
        outcome_id: o.id,
        kind: o.kind,
        description: o.description,
        final_status: "verified",
      });
    } else {
      await markOutcomeFailed(ctx.admin, {
        id: o.id,
        workspace_id: ctx.workspace_id,
        from: o.status as "pending" | "done",
        reason: decision.reason,
      });
      const r: OutcomeHonorResult = {
        outcome_id: o.id,
        kind: o.kind,
        description: o.description,
        final_status: "failed",
        failed_reason: decision.reason,
      };
      summary.attempted.push(r);
      summary.failed_items.push(r);
      summary.all_verified = false;
    }
  }

  return summary;
}

/**
 * Given a completed honor summary, derive the {@link stampResolutionVerified}-shaped verdict the
 * ticket_resolution_events row for this turn should carry. The mapping is:
 *   - honor pass verified everything                      → 'confirmed'
 *   - honor pass had a failure (verify returned false)    → 'drifted'
 *   - honor pass ran but a claim couldn't be backed       → 'unbacked' (caller decides; used by
 *     the Phase-3 send guard when the reply asserted an outcome whose row isn't verified)
 *
 * Callers use this to keep the ledger stamp consistent with the honor result. The stamp itself
 * still goes through action-executor's private `stampResolutionVerified`; this helper only
 * translates the summary shape into the enum.
 */
export function honorSummaryToLedgerOutcome(
  summary: HonorSummary,
): "confirmed" | "drifted" | "unbacked" {
  if (summary.all_verified) return "confirmed";
  // Any failed item — the honor step's verify returned false or handler failed. That's 'drifted'
  // in ticket_resolution_events terms (the executor's claim couldn't be backed by a DB read).
  if (summary.failed_items.length > 0 || summary.carried_forward_failed.length > 0) return "drifted";
  // Fallback — not_verified with no failed items shouldn't happen with the current logic, but
  // treat it as 'unbacked' (the send guard's shape) so callers can still make progress.
  return "unbacked";
}
