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
import { errText } from "@/lib/error-text";
import type { ActionParams, ActionContext, ActionResult } from "./action-executor";
import { directActionHandlers, hasDiscountCode, stillHasDiscountCode, verifyActionInDB } from "./action-executor";
import {
  listRequiredOutcomes,
  markOutcomeDone,
  markOutcomeVerified,
  markOutcomeFailed,
  type TicketRequiredOutcome,
  type RequiredOutcomeStatus,
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
    return { verdict: "failed", reason: `handler threw: ${errText(err)}` };
  }
  if (!handlerResult.success) {
    return { verdict: "failed", reason: handlerResult.error ?? "handler returned success=false" };
  }
  let verified: boolean;
  try {
    verified = await verify(action);
  } catch (err) {
    return { verdict: "failed", reason: `verify threw: ${errText(err)}` };
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

/** One row the reconciler touched (or considered) on the approve_remedy success path. */
export interface OutcomeReconcileResult {
  outcome_id: string;
  kind: string;
  description: string;
  from_status: Exclude<RequiredOutcomeStatus, "verified">;
  /** `verified` means the CAS from `from_status` → `verified` landed. `left_open` means the live
   * DB predicate did NOT hold, so the row was left in its prior terminal state (no false close). */
  outcome: "verified" | "left_open";
}

/** Rollup of one reconcile pass. */
export interface ReconcileSummary {
  reconciled: OutcomeReconcileResult[];
  left_open: OutcomeReconcileResult[];
  /** Rows whose kind wasn't in the fired-kinds set — untouched. */
  skipped_kind_mismatch: number;
  /** Rows already verified when the reconciler ran — untouched. */
  skipped_already_verified: number;
}

/** A fired action a rescue path is offering to the reconciler for target-identity matching. */
export interface FiredActionRef {
  actionType: string;
  actionParams: Record<string, unknown>;
}

/**
 * Identity-field set per action kind — the concrete target-ids fields the reconciler REQUIRES to
 * match a stored row against a fired action. Same-kind alone is INSUFFICIENT: `verifyActionInDB`'s
 * broad arms (create_return in particular) confirm ANY non-cancelled return on the ticket, so a
 * successful return on order A would false-close a failed row for order B on the same ticket
 * without an identity guard. The set below is the "concrete target identity" for each kind — the
 * fields that pin the row to a specific subscription / order / code the rescue must have targeted.
 *
 * A row whose kind is here MUST carry at least one of these fields on `target_ids` AND every
 * present field must match the fired action's `actionParams` for the reconciler to run — an empty
 * target_ids on an identity-sensitive kind fails-closed (leaves the row open).
 */
export const KIND_IDENTITY_FIELDS: Record<string, readonly string[]> = {
  // Returns + refunds — target one specific order
  create_return: ["order_id", "shopify_order_id", "order_number"],
  partial_refund: ["order_id", "shopify_order_id", "order_number"],
  redeem_points_as_refund: ["order_id", "shopify_order_id", "order_number"],
  dollar_replacement: ["order_id", "shopify_order_id", "order_number"],
  create_replacement_order: ["order_id", "shopify_order_id", "order_number"],
  // Subscription mutations — target one specific contract
  cancel: ["contract_id"],
  pause: ["contract_id"],
  crisis_pause: ["contract_id"],
  resume: ["contract_id"],
  change_next_date: ["contract_id"],
  swap: ["contract_id"],
  // Coupons — code AND (usually) contract_id
  apply_coupon: ["contract_id", "code"],
  remove_coupon: ["contract_id", "code"],
};

/**
 * Pure target-identity match. Returns the fired action that has:
 *   1. `actionType === row.kind`, AND
 *   2. Every identity field the row's `target_ids` carries (from the kind's `KIND_IDENTITY_FIELDS`
 *      set, or from `target_ids` itself when the kind isn't in the map) matches the fired
 *      action's `actionParams`.
 *
 * Fail-closed shape:
 *   - A row with EMPTY `target_ids` on an identity-sensitive kind never matches — the row can't
 *     prove which order/subscription/code it tracked, so the reconciler leaves it open (a human
 *     re-authors a fresh Direction to retry, per the terminal-failures-are-not-retried invariant).
 *   - A fired action missing one of the row's identity fields never matches — we can't confirm
 *     the fired action targeted the same object.
 *   - Cross-key aliasing (row names `order_number`, fired names `shopify_order_id`) does NOT
 *     match — the caller (`handleApproveRemedy`) normalizes upstream if a match is intended.
 */
export function findMatchingFiredAction(
  row: TicketRequiredOutcome,
  firedActions: readonly FiredActionRef[],
): FiredActionRef | null {
  const rowIds = (row.target_ids ?? {}) as Record<string, unknown>;
  const isIdentitySensitive = row.kind in KIND_IDENTITY_FIELDS;
  const knownFields = KIND_IDENTITY_FIELDS[row.kind];
  // For an identity-sensitive kind: only compare the KNOWN identity fields the row carries.
  // For an unknown kind: fall back to every non-empty field on the row's target_ids.
  const candidateFields = knownFields ?? Object.keys(rowIds);
  const rowPresent = candidateFields.filter((f) => {
    const v = rowIds[f];
    return v != null && v !== "";
  });
  // Fail-closed: an identity-sensitive kind whose row has no concrete identity fields cannot be
  // matched. This is the sec:real-vuln fix — a target-less row on `create_return` would otherwise
  // be closed on kind alone the moment ANY create_return fires on the ticket.
  if (isIdentitySensitive && rowPresent.length === 0) return null;
  // A kind not in the identity map with an empty target_ids: also fail closed. A row that names
  // no target at all has no identity to prove same-target on.
  if (rowPresent.length === 0) return null;

  for (const fired of firedActions) {
    if (fired.actionType !== row.kind) continue;
    const params = fired.actionParams as Record<string, unknown>;
    let allMatch = true;
    for (const f of rowPresent) {
      const rowVal = rowIds[f];
      const firedVal = params[f];
      if (firedVal == null || firedVal === "") { allMatch = false; break; }
      if (String(firedVal) !== String(rowVal)) { allMatch = false; break; }
    }
    if (allMatch) return fired;
  }
  return null;
}

/** Per-row verdict from {@link classifyOutcomeForReconcile} — the pure classification step. */
export type ReconcileClassification =
  | { verdict: "skip_verified" }
  | { verdict: "skip_done" }
  | { verdict: "skip_kind_mismatch" }
  | { verdict: "verify_and_reconcile"; matched: FiredActionRef };

/**
 * Pure classification: given a stored required-outcome row and the fired actions a rescue just
 * completed, decide which reconcile branch the row falls into.
 *   - `skip_verified`      — row is already closed. No work to do.
 *   - `skip_done`          — normal honor path owns `done`; the reconciler is only for the
 *                            pending-never-attempted / failed-terminal states the honor step
 *                            can't advance.
 *   - `skip_kind_mismatch` — no fired action matches this row's KIND *and* target identity. This
 *                            arm covers the sec:real-vuln: a same-kind rescue on a DIFFERENT
 *                            order/subscription MUST NOT close this row.
 *   - `verify_and_reconcile` — a fired action matches the row's kind AND every identity field the
 *                            row's target_ids carries; the caller runs `verifyActionInDB` and
 *                            marks the row verified iff the live predicate holds.
 *
 * Kept pure so tests can drive each branch without a DB or the executor's real verify.
 */
export function classifyOutcomeForReconcile(
  row: TicketRequiredOutcome,
  firedActions: readonly FiredActionRef[],
): ReconcileClassification {
  if (row.status === "verified") return { verdict: "skip_verified" };
  if (row.status === "done") return { verdict: "skip_done" };
  const matched = findMatchingFiredAction(row, firedActions);
  if (matched == null) return { verdict: "skip_kind_mismatch" };
  return { verdict: "verify_and_reconcile", matched };
}

/**
 * A canonical order reference the target-exact verifier can resolve to an `orders.id` in the
 * matched row's workspace. At least one field must be present; `order_id` (an already-resolved
 * orders.id) is preferred, `shopify_order_id` is uniquely indexed, and `order_number` requires a
 * workspace-scoped lookup.
 */
export interface CanonicalOrderRef {
  order_id: string | null;
  shopify_order_id: string | null;
  order_number: string | null;
}

/**
 * The planner's verdict — the concrete target-exact predicate the reconcile verifier will run
 * against the DB, or `insufficient_identity` when the row (matched by
 * {@link findMatchingFiredAction}) still doesn't carry enough identity to run a target-exact check.
 * Fail-closed on the insufficient path is the sec:real-vuln invariant — the broad
 * `verifyActionInDB` predicates (`create_return`: any non-cancelled return on the ticket;
 * refund kinds: `true` when `shopify_order_id` is missing) would otherwise verify without proof
 * of the exact target.
 */
export type ReconcileVerifierPlan =
  | { kind: "insufficient_identity"; reason: string }
  | { kind: "check_return_for_order"; orderRef: CanonicalOrderRef }
  | { kind: "check_order_financial"; orderRef: CanonicalOrderRef }
  | { kind: "check_sub_status"; contract_id: string; expected: "cancelled" | "paused" | "active" }
  | { kind: "check_sub_next_date"; contract_id: string; date: string }
  | { kind: "check_coupon_applied"; contract_id: string; code: string }
  | { kind: "check_coupon_removed"; contract_id: string; code: string };

function trimmedString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function pickOrderRef(
  rowIds: Record<string, unknown>,
  firedParams: Record<string, unknown>,
): CanonicalOrderRef | null {
  // Prefer identity fields the ROW carries — `findMatchingFiredAction` already asserted every
  // present row identity field matches the fired action, so the row and fired-action orderRefs are
  // equivalent for the fields the row named. Fill missing fields from the fired action too, so a
  // row that only has `order_number` still benefits when the fired action carried a
  // shopify_order_id (the verifier's most-specific read).
  const order_id =
    trimmedString(rowIds.order_id) ?? trimmedString(firedParams.order_id);
  const shopify_order_id =
    trimmedString(rowIds.shopify_order_id) ?? trimmedString(firedParams.shopify_order_id);
  const order_number =
    trimmedString(rowIds.order_number) ?? trimmedString(firedParams.order_number);
  if (!order_id && !shopify_order_id && !order_number) return null;
  return { order_id, shopify_order_id, order_number };
}

/** Kinds whose expected-DB predicate lives on a specific subscription. */
const SUB_STATUS_KIND_EXPECTED: Record<string, "cancelled" | "paused" | "active"> = {
  cancel: "cancelled",
  pause: "paused",
  crisis_pause: "paused",
  pause_timed: "paused",
  resume: "active",
  reactivate: "active",
};

/** Kinds whose expected-DB predicate reads the `returns` table scoped to a specific order. */
const RETURN_KINDS = new Set([
  "create_return",
  "create_replacement",
  "create_replacement_order",
]);

/** Kinds whose expected-DB predicate reads the target `orders` row's financial_status. */
const REFUND_KINDS = new Set([
  "partial_refund",
  "full_order_refund",
  "redeem_points_as_refund",
  "dollar_replacement",
]);

/**
 * Pure classifier: given the matched (row, fired action) pair, decide the target-exact predicate
 * the verifier will run — or that identity is insufficient (in which case the reconciler leaves
 * the row open). Kept pure so tests can pin every kind's plan without a DB. Fail-closed on:
 *   - Order-scoped kinds when no canonical order identity is present on the row/fired action.
 *   - Subscription kinds when `contract_id` is missing.
 *   - Coupon kinds when `contract_id` or `code` is missing.
 *   - Any kind we don't recognize (unknown kinds never auto-verify — a fresh Direction is required).
 */
export function planReconcileVerification(
  row: TicketRequiredOutcome,
  matched: FiredActionRef,
): ReconcileVerifierPlan {
  const rowIds = (row.target_ids ?? {}) as Record<string, unknown>;
  const firedParams = (matched.actionParams ?? {}) as Record<string, unknown>;

  if (RETURN_KINDS.has(row.kind)) {
    const orderRef = pickOrderRef(rowIds, firedParams);
    if (!orderRef) return { kind: "insufficient_identity", reason: "return kind requires order identity" };
    return { kind: "check_return_for_order", orderRef };
  }

  if (REFUND_KINDS.has(row.kind)) {
    const orderRef = pickOrderRef(rowIds, firedParams);
    if (!orderRef) return { kind: "insufficient_identity", reason: "refund kind requires order identity" };
    return { kind: "check_order_financial", orderRef };
  }

  const subExpected = SUB_STATUS_KIND_EXPECTED[row.kind];
  if (subExpected) {
    const contract_id = trimmedString(rowIds.contract_id);
    if (!contract_id) return { kind: "insufficient_identity", reason: "subscription kind requires contract_id" };
    return { kind: "check_sub_status", contract_id, expected: subExpected };
  }

  if (row.kind === "change_next_date") {
    const contract_id = trimmedString(rowIds.contract_id);
    if (!contract_id) return { kind: "insufficient_identity", reason: "change_next_date requires contract_id" };
    const date = trimmedString(firedParams.date) ?? trimmedString(rowIds.date);
    if (!date) return { kind: "insufficient_identity", reason: "change_next_date requires a target date" };
    return { kind: "check_sub_next_date", contract_id, date };
  }

  if (row.kind === "apply_coupon" || row.kind === "apply_loyalty_coupon") {
    const contract_id = trimmedString(rowIds.contract_id);
    const code = trimmedString(rowIds.code) ?? trimmedString(firedParams.code);
    if (!contract_id || !code) return { kind: "insufficient_identity", reason: "coupon apply requires contract_id + code" };
    return { kind: "check_coupon_applied", contract_id, code };
  }

  if (row.kind === "remove_coupon") {
    const contract_id = trimmedString(rowIds.contract_id);
    const code =
      trimmedString(rowIds.code) ??
      trimmedString(firedParams.code) ??
      trimmedString((firedParams as { coupon_code?: unknown }).coupon_code);
    if (!contract_id || !code) return { kind: "insufficient_identity", reason: "coupon remove requires contract_id + code" };
    return { kind: "check_coupon_removed", contract_id, code };
  }

  return { kind: "insufficient_identity", reason: `no target-exact verifier for kind '${row.kind}'` };
}

/**
 * Resolve a {@link CanonicalOrderRef} to a workspace-scoped `orders.id`. Returns null when the
 * ref can't be pinned to exactly one order — the reconciler treats null as fail-closed (leave
 * row open) because we can't prove the target-exact predicate without a concrete DB row.
 *
 * Resolution order:
 *   1. `order_id` — already an orders.id; verify it exists in this workspace and return it.
 *   2. `shopify_order_id` — uniquely indexed; workspace-scoped lookup.
 *   3. `order_number` — workspace-scoped lookup; expected to be unique per workspace.
 */
async function resolveOrderIdForReconcile(
  admin: SupabaseClient,
  workspace_id: string,
  ref: CanonicalOrderRef,
): Promise<string | null> {
  if (ref.order_id) {
    const { data } = await admin
      .from("orders")
      .select("id")
      .eq("workspace_id", workspace_id)
      .eq("id", ref.order_id)
      .maybeSingle();
    const id = (data as { id?: string } | null)?.id;
    if (id) return id;
    // Fall through if the caller-supplied order_id isn't in this workspace — an attacker-supplied
    // cross-tenant id would resolve to null here (workspace-scoped), which is the fail-closed
    // path the sec:real-vuln fix requires.
  }
  if (ref.shopify_order_id) {
    const { data } = await admin
      .from("orders")
      .select("id")
      .eq("workspace_id", workspace_id)
      .eq("shopify_order_id", ref.shopify_order_id)
      .maybeSingle();
    const id = (data as { id?: string } | null)?.id;
    if (id) return id;
  }
  if (ref.order_number) {
    const { data } = await admin
      .from("orders")
      .select("id")
      .eq("workspace_id", workspace_id)
      .eq("order_number", ref.order_number)
      .maybeSingle();
    const id = (data as { id?: string } | null)?.id;
    if (id) return id;
  }
  return null;
}

/**
 * Target-exact DB verifier for the reconciler. Runs the plan {@link planReconcileVerification}
 * produced against the actual DB, bound to the SPECIFIC target the row named. Replaces the broad
 * {@link verifyActionInDB} call on the reconciler path:
 *
 *   - `create_return` / `create_replacement` / `create_replacement_order`: instead of asking "any
 *     non-cancelled return on the ticket?", asks "does a non-cancelled return exist on THIS
 *     ticket AND against THIS resolved orders.id?". A wrong-order rescue can no longer close a
 *     failed row targeting a different order.
 *   - `partial_refund` / `full_order_refund` / `redeem_points_as_refund` / `dollar_replacement`:
 *     instead of returning true when `shopify_order_id` is missing, resolves the row's canonical
 *     order identity to a specific `orders.id` and reads THAT row's `financial_status`. An
 *     `order_number`-only row is accepted only when the workspace-scoped lookup pins it to one
 *     order.
 *   - Subscription/coupon kinds: hard-require `contract_id` (+ `code` for coupons); no
 *     silent-`true` fallback on missing identity.
 *
 * Any error thrown during a read is treated as "did not verify" — the failed row stays failed;
 * the pending row stays pending. Never a false close on a broken read.
 */
export async function verifyReconcileTargetExact(
  ctx: HonorContext,
  row: TicketRequiredOutcome,
  matched: FiredActionRef,
): Promise<boolean> {
  const plan = planReconcileVerification(row, matched);
  if (plan.kind === "insufficient_identity") return false;

  switch (plan.kind) {
    case "check_return_for_order": {
      const orderId = await resolveOrderIdForReconcile(ctx.admin, ctx.workspace_id, plan.orderRef);
      if (!orderId) return false;
      const { data, error } = await ctx.admin
        .from("returns")
        .select("id, status")
        .eq("workspace_id", ctx.workspace_id)
        .eq("ticket_id", ctx.ticket_id)
        .eq("order_id", orderId)
        .neq("status", "cancelled")
        .limit(1);
      if (error) return false;
      return (data ?? []).length > 0;
    }
    case "check_order_financial": {
      const orderId = await resolveOrderIdForReconcile(ctx.admin, ctx.workspace_id, plan.orderRef);
      if (!orderId) return false;
      const { data, error } = await ctx.admin
        .from("orders")
        .select("financial_status")
        .eq("workspace_id", ctx.workspace_id)
        .eq("id", orderId)
        .maybeSingle();
      if (error) return false;
      const fs = (data as { financial_status?: string } | null)?.financial_status;
      return fs === "partially_refunded" || fs === "refunded";
    }
    case "check_sub_status": {
      const { data, error } = await ctx.admin
        .from("subscriptions")
        .select("status")
        .eq("workspace_id", ctx.workspace_id)
        .eq("shopify_contract_id", plan.contract_id)
        .maybeSingle();
      if (error) return false;
      const st = (data as { status?: string } | null)?.status;
      return st === plan.expected;
    }
    case "check_sub_next_date": {
      const { data, error } = await ctx.admin
        .from("subscriptions")
        .select("next_billing_date")
        .eq("workspace_id", ctx.workspace_id)
        .eq("shopify_contract_id", plan.contract_id)
        .maybeSingle();
      if (error) return false;
      const nbd = (data as { next_billing_date?: string } | null)?.next_billing_date;
      if (!nbd) return false;
      return String(nbd).slice(0, 10) === plan.date.slice(0, 10);
    }
    case "check_coupon_applied": {
      const { data, error } = await ctx.admin
        .from("subscriptions")
        .select("applied_discounts")
        .eq("workspace_id", ctx.workspace_id)
        .eq("shopify_contract_id", plan.contract_id)
        .maybeSingle();
      if (error) return false;
      const ad = (data as { applied_discounts?: unknown } | null)?.applied_discounts;
      return hasDiscountCode(ad, plan.code);
    }
    case "check_coupon_removed": {
      const { data, error } = await ctx.admin
        .from("subscriptions")
        .select("applied_discounts")
        .eq("workspace_id", ctx.workspace_id)
        .eq("shopify_contract_id", plan.contract_id)
        .maybeSingle();
      if (error) return false;
      const ad = (data as { applied_discounts?: unknown } | null)?.applied_discounts;
      return !stillHasDiscountCode(ad, plan.code);
    }
  }
}

/**
 * Reconcile a ticket's PENDING and FAILED required-outcome rows against live DB state after a
 * rescue action fired. The CS Director approve_remedy path is the primary caller — when June
 * rescues a ticket whose earlier Sol-authored action self-blocked (the `create_return` order-level
 * coupon ceiling bug on ticket cc78ad94 is the ground-truth incident), the tracking
 * ticket_required_outcomes row sits in `status='failed'` and the outcome-completion gate keeps
 * `hasUnverifiedOutcomes=true` forever, re-escalating a fully-resolved ticket on every tick.
 *
 * This helper closes that loop with TWO consecutive fail-closed gates:
 *   1. Walks {@link listRequiredOutcomes} for the ticket.
 *   2. IDENTITY GATE — for each row whose `status` is `pending` or `failed`, calls
 *      {@link findMatchingFiredAction}: the row's kind must equal a fired action's `actionType`,
 *      AND every identity field the row's `target_ids` names for that kind must match the fired
 *      action's `actionParams`. A row without concrete target identity fails-closed.
 *   3. TARGET-EXACT VERIFY — runs {@link verifyReconcileTargetExact}, NOT the broad
 *      {@link verifyActionInDB}. `verifyActionInDB`'s `create_return` arm asks "does ANY
 *      non-cancelled return exist on this ticket?" and its refund arms return `true` when
 *      `shopify_order_id` is missing — either would false-close a row for a different order on
 *      the same ticket. `verifyReconcileTargetExact` resolves the row's canonical order to a
 *      specific `orders.id` and reads THAT row's state; subscription/coupon kinds hard-require
 *      `contract_id` (+ `code`), never silent-`true` on missing identity.
 *   4. If BOTH gates pass, CAS from the row's current status → `verified`. If either fails, the
 *      row is left in its prior state (no false close on a broken read or a different target).
 *
 * Rows already `verified` are skipped. Rows in `done` are left alone (owned by whoever set them
 * to done; the normal honor path completes them). Idempotent — a second call on the same state
 * is a no-op.
 *
 * NEVER retries a failed row's dispatch. This helper ONLY re-reads live DB state and closes rows
 * whose predicate the rescue action already made true. A caller who wants to actually re-fire a
 * failed dispatch is on the honor path (authoring a fresh Direction / required-outcome row).
 */
export async function reconcileRequiredOutcomesForFiredActions(
  ctx: HonorContext,
  firedActions: readonly FiredActionRef[],
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    reconciled: [],
    left_open: [],
    skipped_kind_mismatch: 0,
    skipped_already_verified: 0,
  };
  if (firedActions.length === 0) return summary;
  const outcomes = await listRequiredOutcomes(ctx.admin, ctx.ticket_id, {
    workspace_id: ctx.workspace_id,
  });
  const actionCtx = toActionContext(ctx);

  for (const o of outcomes) {
    const cls = classifyOutcomeForReconcile(o, firedActions);
    if (cls.verdict === "skip_verified") {
      summary.skipped_already_verified += 1;
      continue;
    }
    if (cls.verdict === "skip_done") continue;
    if (cls.verdict === "skip_kind_mismatch") {
      summary.skipped_kind_mismatch += 1;
      continue;
    }
    // verify_and_reconcile — a fired action's target identity matched the row. Now run the
    // TARGET-EXACT verifier (NOT the broad verifyActionInDB) — the create_return arm of the
    // broad predicate confirms any non-cancelled return on the ticket, and the refund arms
    // return true when shopify_order_id is missing, either of which would false-close a row
    // for a different order on the same ticket. The target-exact verifier resolves the row's
    // canonical order to a specific orders.id and reads THAT row's state.
    let verified = false;
    try {
      verified = await verifyReconcileTargetExact(ctx, o, cls.matched);
    } catch (err) {
      const _reason = errText(err);
      void _reason;
      verified = false;
    }
    if (!verified) {
      summary.left_open.push({
        outcome_id: o.id,
        kind: o.kind,
        description: o.description,
        from_status: o.status as Exclude<RequiredOutcomeStatus, "verified" | "done">,
        outcome: "left_open",
      });
      continue;
    }
    const updated = await markOutcomeVerified(ctx.admin, {
      id: o.id,
      workspace_id: ctx.workspace_id,
      from: o.status as "pending" | "failed",
    });
    const result: OutcomeReconcileResult = {
      outcome_id: o.id,
      kind: o.kind,
      description: o.description,
      from_status: o.status as Exclude<RequiredOutcomeStatus, "verified" | "done">,
      outcome: updated ? "verified" : "left_open",
    };
    if (updated) summary.reconciled.push(result);
    else summary.left_open.push(result);
  }

  return summary;
}
