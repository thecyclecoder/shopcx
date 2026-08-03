/**
 * june-remedy-approval — the founder-approval gate on the CS Director's money remedies.
 *
 * June (CS Director) autonomously executes most remedies on an escalated ticket (date changes,
 * coupons within limit, replacements, resends) — but a REFUND above a workspace threshold routes to
 * the founder for a yes/no/ask decision BEFORE it fires. The founder decides via SMS + Eve's cockpit
 * ([[god-mode]]): June parks the remedy, raises a plain-language decision card into the active
 * god-mode session, and texts the founder immediately (a customer is waiting — no 5-min nudge delay).
 *
 * Flow (locked with the founder 2026-07-10):
 *   1. handleApproveRemedy ([[cs-director]]) calls `remedyNeedsFounderApproval` BEFORE executing.
 *   2. Gated → `raiseJuneRemedyApproval`: ensure a cockpit session, openApproval (the parked remedy
 *      lives in the card's tool_input), send the SMS, hold the ticket escalated-to-owner. NO execution,
 *      NO customer message yet.
 *   3. The founder taps Approve / Deny / Ask in Eve's cockpit.
 *   4. `executeApprovedJuneRemedies` (the box-worker ~60s god-mode sweep) picks up the decided card:
 *      Approve → execute the parked remedy + deliver the customer reply (in the channel persona, never
 *      "June") + close/deescalate. Deny → note it, leave escalated for a human. Idempotent via an
 *      `executed_at` stamp inside the card's tool_input (no schema change on god_mode_approvals).
 *
 * North star: June optimizes a bounded proxy (resolve the ticket); a spend over the rail escalates to
 * the objective-owner (the founder) rather than executing silently. See [[../operational-rules]].
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { LOYALTY_REMEDY_MAX_CENTS } from "@/lib/loyalty";
import type { CxOrderRemedyState } from "@/lib/cx-agent-sdk";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The remedy action types that MOVE MONEY / issue a credit — the class the founder gate covers.
 *
 * `apply_loyalty_coupon` + `redeem_points` are in the set (spec:
 * loyalty-remedy-hard-cap-15-no-cashout-makewhole-june-never-escalates Phase 3) so the founder
 * approval gate is aware of every loyalty-derived spend. Combined with the sibling
 * `planNeedsLoyaltyRefusal` guard below, this closes the pre-Phase-3 blind-spot where a $150
 * loyalty make-whole could be proposed, parked, and approved — a loyalty benefit is now capped
 * upfront by `LOYALTY_REMEDY_MAX_CENTS`, refused hard when over cap, never routed to the founder
 * for a make-whole ask.
 */
export const MONEY_ACTION_TYPES = new Set<string>([
  "partial_refund",
  "redeem_points_as_refund",
  "create_replacement_order",
  "dollar_replacement",
  "apply_loyalty_coupon",
  "redeem_points",
]);

/**
 * The loyalty-derived action types the ceiling guard applies to (spec:
 * loyalty-remedy-hard-cap-15-no-cashout-makewhole-june-never-escalates Phase 3). A superset of
 * every action whose value is a loyalty payout — coupon mint (`redeem_points`), coupon apply
 * (`apply_loyalty_coupon`), or cash refund via a redemption (`redeem_points_as_refund`). Kept
 * separate from `MONEY_ACTION_TYPES` because the founder gate SUMS money across the batch, while
 * this set is scanned per-action for the hard-cap ceiling.
 */
export const LOYALTY_ACTION_TYPES = new Set<string>([
  "apply_loyalty_coupon",
  "redeem_points",
  "redeem_points_as_refund",
]);

/** The `tool_name` on the god_mode_approvals card that carries a parked June remedy. */
export const JUNE_REMEDY_TOOL = "june_remedy";
/** The decision category (drives standing "don't ask again" grants). */
export const JUNE_REFUND_CATEGORY = "june_refund";

/** Fallback threshold when the workspace column is missing/unreadable — $50. */
export const DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS = 5000;

/**
 * One money-action line extracted from a remedy — the per-action shape the preview builder + the
 * card's tool_input carry so a human sees each money line separately from the SUM (Phase 3 of
 * multi-action-remedies). `amountCents` is null when the money action's amount is unknown (e.g. a
 * `partial_refund` payload with no `amount_cents`) — the gate treats null as "unsizeable → gate".
 */
export interface MoneyActionLine {
  actionType: string;
  amountCents: number | null;
}

/**
 * Pull the loyalty-derived payout value (cents) from a loyalty action's payload — used by both
 * the founder gate SUM (so a $15 loyalty coupon shows as 1500 cents alongside a partial_refund)
 * and by `planNeedsLoyaltyRefusal` (the hard-cap check). Signals, in preference order:
 *
 *   1. Explicit `amount_cents` (Sonnet sometimes emits it on `redeem_points_as_refund`).
 *   2. `discount_value` as dollars (present on many redemption payloads).
 *   3. A `LOYALTY-<N>-*` coupon code parsed from `code` / `coupon_code`
 *      (`apply_loyalty_coupon` shape). Both `LOYALTY-15-XYZ` (integer dollars) and
 *      `LOYALTY-15.50-XYZ` (decimal) are parsed; a legacy `smile-*` code is not sized here
 *      (no dollar amount embedded — returns null → falls through to the founder-gate
 *      unknown-collapse-to-null path).
 *
 * Returns null when no signal is present (so the founder gate correctly gates on unknown).
 * Pure.
 */
function extractLoyaltyPayloadValueCents(
  actionType: string,
  payload: Record<string, unknown>,
): number | null {
  const rawAmount = payload.amount_cents;
  if (typeof rawAmount === "number" && Number.isFinite(rawAmount)) {
    return Math.round(rawAmount);
  }
  const discountValue = payload.discount_value;
  if (typeof discountValue === "number" && Number.isFinite(discountValue)) {
    return Math.round(discountValue * 100);
  }
  if (actionType === "apply_loyalty_coupon") {
    const codeRaw = payload.code ?? payload.coupon_code;
    if (typeof codeRaw === "string") {
      const m = codeRaw.toUpperCase().match(/^LOYALTY-([0-9]+(?:\.[0-9]+)?)-/);
      if (m) {
        const dollars = Number(m[1]);
        if (Number.isFinite(dollars)) return Math.round(dollars * 100);
      }
    }
  }
  return null;
}

/**
 * Pull the money amount (cents) from ONE payload object — the shared shape used by both a legacy
 * single-action remedy (`{action_type, payload}`) and each step in a multi-action remedy's
 * `actions[]`. Checks `amount_cents` first, then `replacement_amount_cents` (dollar_replacement),
 * then — for a loyalty action type — the loyalty-derived signals in
 * `extractLoyaltyPayloadValueCents` (so a $15 LOYALTY-* coupon SUMS into the founder gate as
 * 1500 cents instead of collapsing the batch to an unsizeable/unknown-gate result).
 * Returns null when no signal is present. Pure.
 */
function extractPayloadAmountCents(
  payload: Record<string, unknown>,
  actionType?: string,
): number | null {
  const raw = payload.amount_cents ?? payload.replacement_amount_cents;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
  if (actionType && LOYALTY_ACTION_TYPES.has(actionType)) {
    return extractLoyaltyPayloadValueCents(actionType, payload);
  }
  return null;
}

/**
 * Walk a remedy and return the ORDERED per-money-action lines June authored. Handles both shapes:
 *  - Legacy single-action: `{action_type, payload}` → returns 0 or 1 lines.
 *  - Multi-action (Phase 1+ of multi-action-remedies): `{actions:[{action_type, payload}, ...]}` →
 *    returns one line PER money action in June's authored order; non-money actions are skipped.
 * Pure. Used by both remedyMoneyAmountCents (SUM) and the preview builder (per-line list).
 */
export function extractRemedyMoneyLines(
  remedy: Record<string, unknown> | null | undefined,
): MoneyActionLine[] {
  if (!remedy || typeof remedy !== "object" || Array.isArray(remedy)) return [];
  const steps: Record<string, unknown>[] = [];
  if (Array.isArray(remedy.actions) && remedy.actions.length > 0) {
    for (const raw of remedy.actions) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        steps.push(raw as Record<string, unknown>);
      }
    }
  } else {
    steps.push(remedy);
  }
  const lines: MoneyActionLine[] = [];
  for (const step of steps) {
    const actionType = typeof step.action_type === "string" ? step.action_type.trim() : "";
    if (!MONEY_ACTION_TYPES.has(actionType)) continue;
    const payload =
      step.payload && typeof step.payload === "object" && !Array.isArray(step.payload)
        ? (step.payload as Record<string, unknown>)
        : {};
    lines.push({ actionType, amountCents: extractPayloadAmountCents(payload, actionType) });
  }
  return lines;
}

/**
 * Extract the TOTAL money amount (cents) a remedy would move, summed across every money action in
 * the batch (Phase 3 of multi-action-remedies). Returns null when there are NO money actions AND
 * when ANY money action has an unknown amount — both cases the gate needs to distinguish from a
 * finite number (unknown → force gate; none → nothing to gate). Pure.
 */
export function remedyMoneyAmountCents(remedy: Record<string, unknown> | null | undefined): number | null {
  const lines = extractRemedyMoneyLines(remedy);
  if (lines.length === 0) return null;
  let sum = 0;
  for (const line of lines) {
    // ANY unknown amount collapses the whole sum to null — a refund we can't size cannot be
    // reported as a number (would silently under-report the fix's true spend). The gate reads
    // null-amount as "unsizeable → gate" so the founder still sees it.
    if (line.amountCents === null) return null;
    sum += line.amountCents;
  }
  return sum;
}

export interface FounderApprovalDecision {
  /** True → do NOT auto-execute; route to the founder. */
  gated: boolean;
  /** The primary money action (first money line's type). Null when the batch has no money actions. */
  actionType: string | null;
  /** The SUMMED money amount in cents across every money action in the batch (null when unknown —
   *  an unknown amount on ANY money action still gates). */
  amountCents: number | null;
  /** Ordered per-money-action lines (Phase 3 of multi-action-remedies). Length 0 → no money in the
   *  batch. Length 1 → legacy single-action shape. Length ≥ 2 → multi-action batch; the preview
   *  builder lists each line separately from the SUM. */
  moneyLines: MoneyActionLine[];
}

/**
 * Decide whether a remedy must go to the founder before executing. Phase 3 of multi-action-remedies:
 * the gate SUMS money across every money action in `actions[]` (partial_refund +
 * redeem_points_as_refund + replacement + dollar_replacement) and gates on the TOTAL vs
 * `workspaces.june_refund_approval_threshold_cents` — so a fix can't dodge the $50 gate by splitting
 * a $60 refund into 2×$30. Any UNKNOWN amount on any money action ALSO gates (never auto-fire a
 * refund we can't size). Non-money-only batches and sub-threshold sums run autonomously. Pure.
 */
export function remedyNeedsFounderApproval(
  remedy: Record<string, unknown> | null | undefined,
  thresholdCents: number,
): FounderApprovalDecision {
  const moneyLines = extractRemedyMoneyLines(remedy);
  if (moneyLines.length === 0) {
    const rawActionType =
      remedy && typeof remedy === "object" && !Array.isArray(remedy) && typeof remedy.action_type === "string"
        ? remedy.action_type.trim()
        : "";
    return { gated: false, actionType: rawActionType || null, amountCents: null, moneyLines: [] };
  }
  const amountCents = remedyMoneyAmountCents(remedy);
  // Unknown amount on ANY money action → gate (conservative). Known amounts → gate only when
  // SUM > threshold. This is what makes 2×$30 behave identically to a single $60 at the gate.
  const gated = amountCents === null || amountCents > thresholdCents;
  return {
    gated,
    actionType: moneyLines[0].actionType,
    amountCents,
    moneyLines,
  };
}

/**
 * The subset of a `RemedyExecutionPlan` action the gate needs — the canonical `actionType` the
 * executor will fire + the payload it will hand to that handler. Kept structurally minimal so
 * cs-director can pass its `plan.actions[]` directly with no adapter.
 */
export interface PlannedActionForGate {
  actionType: string;
  actionParams: Record<string, unknown>;
}

/**
 * Decide the founder gate against a NORMALIZED planned batch (the same `plan.actions[]` the
 * executor will fire). Same semantics as `remedyNeedsFounderApproval` — money actions are summed
 * across the batch, ANY unknown amount collapses the sum to null (→ gate), non-money-only batches
 * run autonomously — but it reads the plan's canonical `actionType` for each step instead of the
 * remedy's raw `action_type`. Closes the payload.type-override bypass class: the sum the gate
 * asserts is EXACTLY the set of action types the executor will fire.
 */
export function planNeedsFounderApproval(
  actions: readonly PlannedActionForGate[],
  thresholdCents: number,
): FounderApprovalDecision {
  const moneyLines: MoneyActionLine[] = [];
  for (const step of actions) {
    if (!MONEY_ACTION_TYPES.has(step.actionType)) continue;
    moneyLines.push({
      actionType: step.actionType,
      amountCents: extractPayloadAmountCents(step.actionParams, step.actionType),
    });
  }
  if (moneyLines.length === 0) {
    return { gated: false, actionType: null, amountCents: null, moneyLines: [] };
  }
  let sum = 0;
  let anyUnknown = false;
  for (const line of moneyLines) {
    if (line.amountCents === null) {
      anyUnknown = true;
      break;
    }
    sum += line.amountCents;
  }
  const amountCents = anyUnknown ? null : sum;
  const gated = amountCents === null || amountCents > thresholdCents;
  return {
    gated,
    actionType: moneyLines[0].actionType,
    amountCents,
    moneyLines,
  };
}

/**
 * Verdict of the loyalty-ceiling refusal predicate. `refused=true` means the CS Director's runner
 * must NOT execute this plan AND must NOT route it to the founder — the CEO's absolute rail says
 * a loyalty-derived benefit above `LOYALTY_REMEDY_MAX_CENTS` is out of scope entirely (no cash-out,
 * make-whole, or expiry-extension). The runner surfaces the refusal as a needs_attention verdict
 * so the ticket goes to a human, never as a founder-approval ask.
 */
export interface LoyaltyRefusalDecision {
  refused: boolean;
  actionType: string | null;
  valueCents: number | null;
  reason: string | null;
}

/**
 * Hard-cap refusal check on a normalized planned batch (spec:
 * loyalty-remedy-hard-cap-15-no-cashout-makewhole-june-never-escalates Phase 3).
 *
 * Scans every loyalty-typed action in the plan (`redeem_points`, `apply_loyalty_coupon`,
 * `redeem_points_as_refund`) — extracts the loyalty payout value via
 * `extractLoyaltyPayloadValueCents` — and REFUSES the whole plan the first time a known value
 * exceeds `LOYALTY_REMEDY_MAX_CENTS`. This is the sibling guard the cs-director runner calls
 * BEFORE `planNeedsFounderApproval`, so an over-cap loyalty make-whole is refused hard (not
 * parked for founder approval — the whole point of Phase 3).
 *
 * When the loyalty payload has no sizeable signal (unknown value), the founder gate still gates
 * on it via the unknown-collapse-to-null rule (that already-existing conservative behavior). The
 * refusal predicate itself only fires on a KNOWN over-cap value — a payload we couldn't size
 * doesn't get a false-positive refuse.
 *
 * Pure. Exported for unit tests.
 */
export function planNeedsLoyaltyRefusal(
  actions: readonly PlannedActionForGate[],
): LoyaltyRefusalDecision {
  for (const step of actions) {
    if (!LOYALTY_ACTION_TYPES.has(step.actionType)) continue;
    const valueCents = extractLoyaltyPayloadValueCents(step.actionType, step.actionParams);
    if (valueCents !== null && valueCents > LOYALTY_REMEDY_MAX_CENTS) {
      const dollars = (valueCents / 100).toFixed(2);
      const cap = (LOYALTY_REMEDY_MAX_CENTS / 100).toFixed(2);
      return {
        refused: true,
        actionType: step.actionType,
        valueCents,
        reason:
          `loyalty benefit $${dollars} (action ${step.actionType}) exceeds the absolute $${cap} ` +
          `loyalty ceiling — cash-out / make-whole / expiry-extension are categorically out of scope, ` +
          `never escalate to the founder to ask`,
      };
    }
  }
  return { refused: false, actionType: null, valueCents: null, reason: null };
}

/**
 * Compose the plain-language card/SMS-context text the founder reads — simple enough to approve at a
 * glance. Two shapes (Phase 3 of multi-action-remedies):
 *  - SINGLE-line (`moneyLines` omitted OR length ≤ 1): renders the legacy string
 *    "Refund $48.00 to Susan on 'Wrong price'?" that prod SMSes + prior tests rely on.
 *  - MULTI-line (`moneyLines` length ≥ 2): names the TOTAL up-front (so a 2×$30 split can't hide
 *    the true spend from the founder) AND lists each money line so the shape of the fix is legible
 *    without opening the tool_input.
 * Pure.
 */
/**
 * One order's remedy-state summary the founder card renders (Phase 1 of
 * a-money-remedy-must-read-the-live-remedy-state-first § bullet 4). A LIVE open return on the
 * target order surfaces at the top of the preview so the founder sees "existing return:
 * label_created, refund on receipt" without having to open the ticket — the exact "so even a
 * proposal that slips through is obvious on sight" surface the spec calls for. The remedy-state
 * hard-reject in cs-director.ts is supposed to catch the double-pay class UPSTREAM, but this line
 * is the defense-in-depth surface for any proposal that gets past it.
 */
export interface RemedyStateForFounderCard {
  orderKey: string;
  totalCents: number;
  refundsSucceededCents: number;
  remainingRefundableCents: number;
  openReturns: Array<{ status: string; netRefundCents: number }>;
}

/**
 * Render a compact founder-card line for the remedy state of the money remedy's target orders.
 * Empty (`[]`) → returns null (nothing to surface). Non-empty → returns a labeled block the
 * preview builder appends BEFORE the "Why:" reasoning. Pure.
 */
export function renderRemedyStatesForCard(states: readonly RemedyStateForFounderCard[]): string | null {
  if (states.length === 0) return null;
  const lines: string[] = ["Live remedy state:"];
  for (const s of states) {
    const totalD = (s.totalCents / 100).toFixed(2);
    const refundedD = (s.refundsSucceededCents / 100).toFixed(2);
    const remainingD = (s.remainingRefundableCents / 100).toFixed(2);
    lines.push(
      `  • order ${s.orderKey}: total $${totalD} · refunded_so_far $${refundedD} · REMAINING REFUNDABLE $${remainingD}`,
    );
    for (const r of s.openReturns) {
      const netD = (r.netRefundCents / 100).toFixed(2);
      lines.push(`    ⚠ existing return: ${r.status}, refund $${netD} on receipt`);
    }
  }
  return lines.join("\n");
}

/**
 * Convert a `CxOrderRemedyState` map to the card-render shape. Kept as a thin adapter so
 * `raiseJuneRemedyApproval` + `raiseFounderApproval` share the same rendering path. Pure.
 */
export function remedyStatesForCardFromMap(
  states: ReadonlyMap<string, CxOrderRemedyState>,
): RemedyStateForFounderCard[] {
  const out: RemedyStateForFounderCard[] = [];
  for (const [key, s] of states) {
    if (!s.found) continue;
    out.push({
      orderKey: s.order_number ?? s.shopify_order_id ?? key,
      totalCents: s.total_cents,
      refundsSucceededCents: s.refunds_succeeded_cents,
      remainingRefundableCents: s.remaining_refundable_cents,
      openReturns: s.open_returns.map((r) => ({
        status: r.status,
        netRefundCents: r.net_refund_cents,
      })),
    });
  }
  return out;
}

export function buildJuneApprovalPreview(input: {
  actionType: string;
  /** The SUMMED money amount in cents (or null when unknown). */
  amountCents: number | null;
  /** Ordered per-money-action lines. Length ≥ 2 triggers the multi-line format. */
  moneyLines?: MoneyActionLine[];
  customerName?: string | null;
  ticketSubject?: string | null;
  reasoning?: string | null;
  /**
   * Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first § bullet 4 — live remedy
   * state for each target order surfaced on the founder card. A LIVE open return renders as
   * "existing return: label_created, refund on receipt" so an anomaly is visible without opening
   * the ticket. Empty / omitted → nothing rendered.
   */
  remedyStates?: RemedyStateForFounderCard[];
}): string {
  const dollars = input.amountCents != null ? `$${(input.amountCents / 100).toFixed(2)}` : "an unspecified amount";
  const who = input.customerName?.trim() ? ` to ${input.customerName.trim()}` : "";
  const subj = input.ticketSubject?.trim() ? ` on "${input.ticketSubject.trim()}"` : "";
  const remedyStateBlock = renderRemedyStatesForCard(input.remedyStates ?? []);
  const remedyStateSuffix = remedyStateBlock ? `\n\n${remedyStateBlock}` : "";
  const why = input.reasoning?.trim() ? `\n\nWhy: ${input.reasoning.trim().slice(0, 400)}` : "";

  const lines = input.moneyLines ?? [];
  if (lines.length >= 2) {
    // Multi-action preview: total → per-line list. Each line reads "  • <action_type>: $X.YZ" (or
    // "an unspecified amount" when null) so the founder sees the split at a glance and can't miss
    // that the $60 total is really 2×$30 (the exact class the sum-gate defends against).
    const bullets = lines
      .map((line) => {
        const lineDollars =
          line.amountCents != null ? `$${(line.amountCents / 100).toFixed(2)}` : "an unspecified amount";
        return `  • ${line.actionType}: ${lineDollars}`;
      })
      .join("\n");
    return `Approve ${dollars} in refunds/credits${who}${subj}?\n${bullets}${remedyStateSuffix}${why}`;
  }

  const verb =
    input.actionType === "create_replacement_order" || input.actionType === "dollar_replacement"
      ? "Send a replacement worth"
      : "Refund";
  return `${verb} ${dollars}${who}${subj}?${remedyStateSuffix}${why}`;
}

/** Read the workspace's refund-approval threshold (cents). Best-effort; falls back to $50. */
export async function getRefundApprovalThresholdCents(admin: Admin, workspaceId: string): Promise<number> {
  try {
    const { data } = await admin
      .from("workspaces")
      .select("june_refund_approval_threshold_cents")
      .eq("id", workspaceId)
      .maybeSingle();
    const v = (data as { june_refund_approval_threshold_cents?: number | null } | null)
      ?.june_refund_approval_threshold_cents;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS;
  } catch {
    return DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS;
  }
}

/** Resolve the workspace owner's user_id (for arming a cockpit session / owning the escalation). */
async function resolveOwnerUserId(admin: Admin, workspaceId: string): Promise<string | null> {
  try {
    const { data } = await admin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("role", "owner")
      .maybeSingle();
    return (data as { user_id?: string } | null)?.user_id ?? null;
  } catch {
    return null;
  }
}

export interface RaiseJuneRemedyResult {
  raised: boolean;
  via:
    | "sms_cockpit"
    | "escalated_no_cockpit"
    | "escalated_recommendation_only"
    // one-open-escalation-per-thing Phase 3: an existing `asked` card for the same subject blocks
    // the re-ask until the founder decides again (or the run consumes the answer). The mint site
    // returned WITHOUT opening a new card. The prior asked card is still live; the founder's answer
    // (its question_text) is the input the next cs-director-call run must consume.
    | "blocked_by_asked"
    // one-open-escalation-per-thing Phase 3: the per-subject ceiling fired — this decision has been
    // asked N times in the window (see JUNE_REASK_CEILING). ONE `dashboard_notifications` card
    // ("Refund decision asked N times — needs a call") is emitted (dedupe key
    // `asked_ceiling:{ticket_id}:{category}`), the DB unique index prevents duplicates, and no new
    // june_remedy card is minted. The founder decides on the summary card, not a fresh remedy card.
    | "blocked_by_ceiling";
  approvalId?: string;
  /**
   * one-open-escalation-per-thing Phase 3 — the question_text the founder's `asked` answer carries.
   * Populated only on `via='blocked_by_asked'` so the caller (cs-director-call resume) can feed it
   * into the next investigation's context as required input. Null otherwise.
   */
  askedQuestionText?: string | null;
}

// ── one-open-escalation-per-thing Phase 3 — an answered question blocks the re-ask ────────────
// The 2026-07-28 incident: the founder answered June's card at 23:47 with a specific investigative
// lens ("look at the customer's LTV before refunding"); June opened four MORE cards over the next
// 2.5h, none of which engaged with the answer. An answer that changes nothing teaches the founder
// that answering is pointless. Two guards close it:
//   (1) BLOCK re-mint while an `asked` card is open for the same subject — the founder is waiting on
//       June to consume the answer, not to open a fresh card that ignores it.
//   (2) BOUND the per-subject re-ask count — after JUNE_REASK_CEILING mints in JUNE_REASK_WINDOW_MS,
//       emit ONE `dashboard_notifications` "this decision has been asked N times" card and stop
//       minting. Reuses Phase 1's DB unique open-card index so the summary card also dedupes to one.

/** The per-subject re-ask ceiling — after this many mints in the window, escalate ONE summary card. */
export const JUNE_REASK_CEILING = 5;
/** The window over which the ceiling counts — 24h matches Phase 2's stale-park window. */
export const JUNE_REASK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * one-open-escalation-per-thing Phase 3 — the pure re-ask decision. Kept pure so the "block vs
 * ceiling vs mint" fork is unit-testable without a Supabase seam.
 *
 *   - `openAskedCount > 0` — an `asked` card is already live for the same (ticket, category);
 *     the founder's answer is waiting to be consumed. Block the new mint, hand the question_text
 *     back so the caller feeds it into the next run.
 *   - `mintCountInWindow >= JUNE_REASK_CEILING` — the founder has been asked this same decision
 *     too many times in the window. Block the new mint; emit the summary card once.
 *   - else — no block; the caller mints normally.
 */
export type ReAskDecision =
  | { block: false }
  | { block: true; kind: "asked_open"; askedQuestionText: string | null }
  | { block: true; kind: "ceiling"; mintCountInWindow: number };

export function computeReAskBlock(state: {
  openAskedCount: number;
  askedQuestionText: string | null;
  mintCountInWindow: number;
}): ReAskDecision {
  if (state.openAskedCount > 0) {
    return { block: true, kind: "asked_open", askedQuestionText: state.askedQuestionText };
  }
  if (state.mintCountInWindow >= JUNE_REASK_CEILING) {
    return { block: true, kind: "ceiling", mintCountInWindow: state.mintCountInWindow };
  }
  return { block: false };
}

/**
 * one-open-escalation-per-thing Phase 3 — read the god_mode_approvals state for a given (ticket,
 * category) subject: how many open `asked` cards exist + what question_text they carry, and how
 * many mints have happened in the window (any status). Read-only. Best-effort: on a DB hiccup
 * returns `{openAskedCount:0, askedQuestionText:null, mintCountInWindow:0}` so the caller falls
 * through to the mint path — the pre-Phase-3 behavior is the safe fallback (never a silent block).
 */
export async function readReAskState(
  admin: Admin,
  input: { workspaceId: string; ticketId: string; category: string; windowMs?: number },
): Promise<{ openAskedCount: number; askedQuestionText: string | null; mintCountInWindow: number }> {
  const windowMs = input.windowMs ?? JUNE_REASK_WINDOW_MS;
  const since = new Date(Date.now() - windowMs).toISOString();
  try {
    const { data } = await admin
      .from("god_mode_approvals")
      .select("id, status, question_text, tool_input, created_at")
      .eq("workspace_id", input.workspaceId)
      .eq("tool_name", JUNE_REMEDY_TOOL)
      .eq("category", input.category)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100);
    // Server can't filter on jsonb `tool_input->>ticket_id` cheaply through PostgREST — do it in JS
    // over the small windowed set. Cards for OTHER tickets are ignored.
    const rows = ((data ?? []) as Array<{ id: string; status: string; question_text: string | null; tool_input: Record<string, unknown>; created_at: string }>)
      .filter((r) => {
        const ti = r.tool_input ?? {};
        const t = (ti as { ticket_id?: string }).ticket_id;
        return typeof t === "string" && t === input.ticketId;
      });
    const asked = rows.filter((r) => r.status === "asked");
    const askedQuestionText = asked.length > 0 ? asked[0].question_text ?? null : null;
    return { openAskedCount: asked.length, askedQuestionText, mintCountInWindow: rows.length };
  } catch (e) {
    console.warn("[june-remedy-approval] readReAskState failed:", e instanceof Error ? e.message : e);
    return { openAskedCount: 0, askedQuestionText: null, mintCountInWindow: 0 };
  }
}

/**
 * one-open-escalation-per-thing Phase 3 — emit the summary "asked N times" dashboard card ONCE per
 * subject. Uses the same [[dashboard_notifications]] surface as the escalation cards (approval_request
 * type + `escalation_kind='asked_ceiling'` + dedupe_key `asked_ceiling:{ticket_id}:{category}` so the
 * DB unique-open-card index from Phase 1 dedupes it). Best-effort; a DB failure logs a warning and
 * returns — the founder still sees the prior N cards in the queue.
 */
async function emitAskedCeilingCard(
  admin: Admin,
  input: { workspaceId: string; ticketId: string; category: string; mintCount: number; preview: string },
): Promise<void> {
  const dedupeKey = `asked_ceiling:${input.ticketId}:${input.category}`;
  const nowIso = new Date().toISOString();
  const title = `Refund decision asked ${input.mintCount} times — needs a call`;
  const body =
    `June has asked you to decide the same remedy on this ticket ${input.mintCount} times in the last ` +
    `${Math.round(JUNE_REASK_WINDOW_MS / (60 * 60 * 1000))} hours. Rather than continuing to mint fresh ` +
    `refund cards, this one is the safety valve: open the ticket to decide, or dismiss it if the answer ` +
    `is already given. Latest card summary: ${input.preview.split("\n")[0]}`;
  try {
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: input.workspaceId,
      type: "agent_approval_request",
      title: title.slice(0, 200),
      body: body.slice(0, 4000),
      link: `/dashboard/tickets/${input.ticketId}`,
      metadata: {
        routed_to_function: "ceo",
        escalation_kind: "asked_ceiling",
        escalation_reason: body.slice(0, 2000),
        dedupe_key: dedupeKey,
        ticket_id: input.ticketId,
        category: input.category,
        mint_count: input.mintCount,
        deep_link: `/dashboard/tickets/${input.ticketId}`,
        approve_action_id: null,
        escalation_seen_count: 1,
        escalation_first_seen_at: nowIso,
        escalation_last_seen_at: nowIso,
      },
      read: false,
      dismissed: false,
    });
    // 23505 unique_violation → the summary card already exists (Phase 1's DB-enforced dedupe). That's
    // the correct STATE either way, so this is a benign no-op — never a re-fire.
    if (error && error.code !== "23505") {
      console.warn(`[june-remedy-approval] asked_ceiling card insert failed: ${error.message}`);
    }
  } catch (e) {
    console.warn("[june-remedy-approval] emitAskedCeilingCard threw:", e instanceof Error ? e.message : e);
  }
}

/**
 * Park a gated remedy for founder approval: raise a decision card into the active Eve cockpit session
 * (arming one if none is live), text the founder immediately, and hold the ticket escalated to the
 * owner with an "Awaiting founder approval" reason. If no cockpit session can be established, FALL
 * BACK to leaving the ticket escalated-to-owner with an internal note — the approval is never silently
 * dropped. Best-effort; never throws.
 */
export async function raiseJuneRemedyApproval(
  admin: Admin,
  input: {
    workspaceId: string;
    ticketId: string;
    remedy: Record<string, unknown>;
    actionType: string;
    amountCents: number | null;
    reasoning: string;
    customerName?: string | null;
    ticketSubject?: string | null;
    /**
     * Per-money-action lines (Phase 3 of multi-action-remedies). When length ≥ 2 the preview lists
     * each money line + the summed total so the founder sees a 2×$30 split can't hide the true $60
     * spend. When omitted / length ≤ 1, the preview renders the legacy single-action string.
     */
    moneyLines?: MoneyActionLine[];
    /**
     * Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first § bullet 4 — live remedy
     * state for the money remedy's target orders. Rendered on the SMS/cockpit preview and stashed
     * on `tool_input.remedy_states` so the CEO card carries the full context (existing return,
     * remaining refundable) that the executor's hard-reject already read.
     */
    remedyStates?: RemedyStateForFounderCard[];
  },
): Promise<RaiseJuneRemedyResult> {
  // Best-effort enrich the preview with the customer's first name + ticket subject so the founder can
  // approve at a glance, without the caller having to thread them through.
  let customerName = input.customerName ?? null;
  let ticketSubject = input.ticketSubject ?? null;
  if (!customerName || !ticketSubject) {
    try {
      const { data: tk } = await admin
        .from("tickets")
        .select("subject, customer_id, customers(first_name)")
        .eq("id", input.ticketId)
        .maybeSingle();
      const row = tk as { subject?: string | null; customers?: { first_name?: string | null } | null } | null;
      ticketSubject = ticketSubject || row?.subject || null;
      customerName = customerName || row?.customers?.first_name || null;
    } catch {
      /* best-effort — the preview still reads fine without them */
    }
  }
  // Fall back to walking the remedy for money lines when the caller didn't precompute them (e.g. a
  // future callsite that has the raw remedy but not the FounderApprovalDecision yet).
  const moneyLines: MoneyActionLine[] =
    input.moneyLines && input.moneyLines.length > 0 ? input.moneyLines : extractRemedyMoneyLines(input.remedy);
  const remedyStates = input.remedyStates ?? [];
  const preview = buildJuneApprovalPreview({
    actionType: input.actionType,
    amountCents: input.amountCents,
    moneyLines,
    customerName,
    ticketSubject,
    reasoning: input.reasoning,
    remedyStates,
  });

  // one-open-escalation-per-thing Phase 3 — an answered question blocks the re-ask. Read the
  // (ticket, category) re-ask state and consult the pure predicate BEFORE we arm a cockpit / open
  // a card / text the founder. Two blocks:
  //   - `asked_open`: a live `asked` card exists — the founder's answer is waiting. Return
  //     `via:'blocked_by_asked'` + the question_text so the caller feeds it into the next run.
  //   - `ceiling`: the founder has already been asked N times in the window → emit ONE summary
  //     card + return `via:'blocked_by_ceiling'`. Never a silent no-op — the ticket stays
  //     escalated-to-owner (below) so nothing is dropped.
  const reAskState = await readReAskState(admin, {
    workspaceId: input.workspaceId,
    ticketId: input.ticketId,
    category: JUNE_REFUND_CATEGORY,
  });
  const reAskDecision = computeReAskBlock(reAskState);
  if (reAskDecision.block) {
    if (reAskDecision.kind === "ceiling") {
      await emitAskedCeilingCard(admin, {
        workspaceId: input.workspaceId,
        ticketId: input.ticketId,
        category: JUNE_REFUND_CATEGORY,
        mintCount: reAskDecision.mintCountInWindow,
        preview,
      });
      await postInternalNote(
        admin,
        input.ticketId,
        `[cs-director] Blocked a re-ask: this refund decision has been surfaced ${reAskDecision.mintCountInWindow} times in the last ${Math.round(JUNE_REASK_WINDOW_MS / (60 * 60 * 1000))}h. Emitted ONE summary "asked ${reAskDecision.mintCountInWindow} times" card instead of another remedy card. Preview: ${preview.split("\n")[0]}`,
      );
      return { raised: false, via: "blocked_by_ceiling" };
    }
    // asked_open
    await postInternalNote(
      admin,
      input.ticketId,
      `[cs-director] Blocked a re-ask: the founder's ${JUNE_REFUND_CATEGORY} card for this ticket is still 'asked' (waiting on June to consume the answer, not another card). Founder's question: "${(reAskDecision.askedQuestionText ?? "(none recorded)").slice(0, 300)}". Preview I would have raised: ${preview.split("\n")[0]}`,
    );
    return { raised: false, via: "blocked_by_asked", askedQuestionText: reAskDecision.askedQuestionText };
  }

  const ownerId = await resolveOwnerUserId(admin, input.workspaceId);

  // Ensure a cockpit session to host the card + give the SMS a link. Reuse the active Eve session;
  // arm one only if none is live (best-effort — the fallback below covers a failed arm).
  let session: { id: string; cockpit_token: string | null } | null = null;
  try {
    const { getActiveSession, armSession } = await import("@/lib/god-mode");
    session = await getActiveSession(admin, input.workspaceId);
    if (!session && ownerId) {
      session = await armSession(admin, { workspaceId: input.workspaceId, createdBy: ownerId });
    }
  } catch (e) {
    console.warn("[june-remedy-approval] cockpit session resolution failed:", e instanceof Error ? e.message : e);
  }

  const now = new Date().toISOString();
  // Hold the ticket escalated to the owner so it surfaces as "with the founder" and no other lane
  // touches it while the decision is pending.
  try {
    await admin
      .from("tickets")
      .update({
        escalated_at: now,
        escalated_to: ownerId,
        escalation_reason: `Awaiting founder approval: ${preview.split("\n")[0]}`,
        updated_at: now,
      })
      .eq("id", input.ticketId)
      .eq("workspace_id", input.workspaceId);
  } catch (e) {
    console.warn("[june-remedy-approval] park-ticket update failed:", e instanceof Error ? e.message : e);
  }

  if (!session) {
    // No cockpit — never drop the approval. Leave it escalated to the owner + audit note.
    await postInternalNote(
      admin,
      input.ticketId,
      `[cs-director] Refund/credit over the approval threshold — no active cockpit to text the founder; left escalated for manual review. ${preview.split("\n")[0]}`,
    );
    return { raised: true, via: "escalated_no_cockpit" };
  }

  let approvalId: string | undefined;
  try {
    const { openApproval, sendGodModeSMS } = await import("@/lib/god-mode");
    const card = await openApproval(admin, {
      sessionId: session.id,
      workspaceId: input.workspaceId,
      toolName: JUNE_REMEDY_TOOL,
      toolInput: {
        ticket_id: input.ticketId,
        remedy: input.remedy,
        reasoning: input.reasoning,
        action_type: input.actionType,
        amount_cents: input.amountCents,
        // Phase 3 (multi-action-remedies): stash the per-money-action lines so the cockpit UI +
        // audit surfaces can show the split (2×$30) alongside the SUM without re-walking
        // remedy.actions[]. JSONB — no schema change on god_mode_approvals.
        money_lines: moneyLines,
        // Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first § bullet 4 — the live
        // remedy state per target order (remaining refundable, live open returns) the executor
        // read to run its hard-reject guard. Stashed on the card so a bounce-back / audit reader
        // sees the exact state the founder had when they tapped Approve.
        remedy_states: remedyStates,
        raised_at: now,
      },
      preview,
      risk: "decision",
      category: JUNE_REFUND_CATEGORY,
    });
    approvalId = card.id;
    // Text immediately — a customer is waiting on this refund; don't leave it for the 5-min nudge.
    await sendGodModeSMS(admin, { workspaceId: input.workspaceId, kind: "approval", cockpitToken: session.cockpit_token });
  } catch (e) {
    console.warn("[june-remedy-approval] raise card / SMS failed:", e instanceof Error ? e.message : e);
  }

  await postInternalNote(
    admin,
    input.ticketId,
    `[cs-director] June parked a remedy for founder approval and texted the founder. ${preview.split("\n")[0]}`,
  );
  return { raised: true, via: "sms_cockpit", approvalId };
}

/** The decision category for a founder-escalation approval (vs the money-threshold `june_refund`). */
export const JUNE_FOUNDER_ESCALATION_CATEGORY = "june_founder_escalation";

/**
 * Plain-language preview for a June escalate_founder approval — works for ANY recommended remedy, not
 * just money actions. The founder reads this on their phone and taps Approve/Decline. Pure.
 */
export function buildFounderApprovalPreview(input: {
  remedy: Record<string, unknown>;
  reasoning?: string | null;
  customerName?: string | null;
  ticketSubject?: string | null;
  remedyStates?: RemedyStateForFounderCard[];
}): string {
  const remedy = input.remedy || {};
  const actionType = typeof remedy.action_type === "string" ? remedy.action_type.trim() : "";
  const payload =
    remedy.payload && typeof remedy.payload === "object" && !Array.isArray(remedy.payload)
      ? (remedy.payload as Record<string, unknown>)
      : {};
  const who = input.customerName?.trim() ? ` for ${input.customerName.trim()}` : "";
  const money = remedyMoneyAmountCents(remedy);
  let action: string;
  if (money != null) {
    const verb = actionType === "create_replacement_order" || actionType === "dollar_replacement" ? "Send a replacement worth" : "Refund";
    action = `${verb} $${(money / 100).toFixed(2)}${who}`;
  } else if (actionType === "add_one_time_gift") {
    const free = payload.free !== false;
    action = `${free ? "Comp a FREE one-time gift" : "Add a one-time item"}${who} on their next order`;
  } else if (actionType) {
    action = `Run "${actionType}"${who}`;
  } else {
    action = `June's recommended action${who}`;
  }
  const subj = input.ticketSubject?.trim() ? ` (re: "${input.ticketSubject.trim()}")` : "";
  const remedyStateBlock = renderRemedyStatesForCard(input.remedyStates ?? []);
  const remedyStateSuffix = remedyStateBlock ? `\n\n${remedyStateBlock}` : "";
  const why = input.reasoning?.trim() ? `\n\nJune: ${input.reasoning.trim().slice(0, 500)}` : "";
  return `${action}${subj}?${remedyStateSuffix}${why}`;
}

/**
 * Raise an Eve SMS approval for a June `escalate_founder` decision that carries a recommended remedy.
 *
 * Unlike `raiseJuneRemedyApproval` (which only gates money actions ABOVE the refund threshold), this
 * fires for ANY founder escalation with an actionable recommendation — a policy-exception judgment
 * call, a $0 goodwill gift, anything June kicks upstairs. The founder's directive: "anything June
 * seeks from me should be a straight-up approval," never a silent dashboard card I have to go hunt.
 *
 * Parks the recommended remedy on a `june_remedy` card (so the SAME `executeApprovedJuneRemedies`
 * sweep executes it on Approve / stands down on Deny), texts the founder immediately, and holds the
 * ticket escalated to the owner. Best-effort; never throws.
 */
export async function raiseFounderApproval(
  admin: Admin,
  input: {
    workspaceId: string;
    ticketId: string;
    remedy: Record<string, unknown>;
    reasoning: string;
    customerName?: string | null;
    ticketSubject?: string | null;
    /**
     * Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first § bullet 4 — live remedy
     * state for the recommended remedy's target orders. Rendered on the founder preview + stashed
     * on `tool_input.remedy_states` so the CEO card carries the full state at approval time.
     */
    remedyStates?: RemedyStateForFounderCard[];
  },
): Promise<RaiseJuneRemedyResult> {
  let customerName = input.customerName ?? null;
  let ticketSubject = input.ticketSubject ?? null;
  if (!customerName || !ticketSubject) {
    try {
      const { data: tk } = await admin
        .from("tickets")
        .select("subject, customers(first_name)")
        .eq("id", input.ticketId)
        .maybeSingle();
      const row = tk as { subject?: string | null; customers?: { first_name?: string | null } | null } | null;
      ticketSubject = ticketSubject || row?.subject || null;
      customerName = customerName || row?.customers?.first_name || null;
    } catch {
      /* best-effort */
    }
  }
  const remedyStates = input.remedyStates ?? [];
  const preview = buildFounderApprovalPreview({ remedy: input.remedy, reasoning: input.reasoning, customerName, ticketSubject, remedyStates });
  const actionType = typeof input.remedy.action_type === "string" ? input.remedy.action_type.trim() : null;
  const amountCents = remedyMoneyAmountCents(input.remedy);

  // one-open-escalation-per-thing Phase 3 — an answered question blocks the re-ask. Same guard as
  // `raiseJuneRemedyApproval` — see the commentary there. Applied BEFORE the park-ticket update so
  // a re-ask-blocked path doesn't repeatedly re-stamp `escalated_at` on the ticket either.
  const reAskState = await readReAskState(admin, {
    workspaceId: input.workspaceId,
    ticketId: input.ticketId,
    category: JUNE_FOUNDER_ESCALATION_CATEGORY,
  });
  const reAskDecision = computeReAskBlock(reAskState);
  if (reAskDecision.block) {
    if (reAskDecision.kind === "ceiling") {
      await emitAskedCeilingCard(admin, {
        workspaceId: input.workspaceId,
        ticketId: input.ticketId,
        category: JUNE_FOUNDER_ESCALATION_CATEGORY,
        mintCount: reAskDecision.mintCountInWindow,
        preview,
      });
      await postInternalNote(
        admin,
        input.ticketId,
        `[cs-director] Blocked a re-ask: this founder escalation has been surfaced ${reAskDecision.mintCountInWindow} times in the last ${Math.round(JUNE_REASK_WINDOW_MS / (60 * 60 * 1000))}h. Emitted ONE summary card instead. Preview: ${preview.split("\n")[0]}`,
      );
      return { raised: false, via: "blocked_by_ceiling" };
    }
    await postInternalNote(
      admin,
      input.ticketId,
      `[cs-director] Blocked a re-ask: the founder's ${JUNE_FOUNDER_ESCALATION_CATEGORY} card for this ticket is still 'asked' (waiting on June to consume the answer). Founder's question: "${(reAskDecision.askedQuestionText ?? "(none recorded)").slice(0, 300)}". Preview I would have raised: ${preview.split("\n")[0]}`,
    );
    return { raised: false, via: "blocked_by_asked", askedQuestionText: reAskDecision.askedQuestionText };
  }

  const ownerId = await resolveOwnerUserId(admin, input.workspaceId);

  const now = new Date().toISOString();
  try {
    await admin
      .from("tickets")
      .update({ escalated_at: now, escalated_to: ownerId, escalation_reason: `Awaiting founder approval: ${preview.split("\n")[0]}`, updated_at: now })
      .eq("id", input.ticketId)
      .eq("workspace_id", input.workspaceId);
  } catch (e) {
    console.warn("[june-remedy-approval] founder-escalation park-ticket failed:", e instanceof Error ? e.message : e);
  }

  // Executable-remedy guard (founder-approval-executable-guard). A `recommended_remedy` is usually a
  // `{kind, summary}` SUGGESTION, not an executable `{action_type, payload}` action. Opening a
  // one-tap `june_remedy` auto-execute card for a non-executable remedy means the
  // `executeApprovedJuneRemedies` sweep hits `planRemedyExecution` → `remedy_missing_action_type` and
  // posts "the parked remedy was malformed — Needs a human" the INSTANT the founder taps Approve
  // (ticket db8b3d66). Don't offer a one-tap approval for something nothing can fire: keep the ticket
  // escalated-to-owner (already parked above) + the runner's CEO dashboard card, and note the
  // recommendation for a manual ruling. Uses the SAME `planRemedyExecution` the sweep would (via the
  // exported `canOfferOneTapApproval` predicate), so the guard matches the executor exactly.
  //
  // ORDERING (Phase 2 of founder-escalations-reach-the-founder). The guard MUST run BEFORE the
  // cockpit session is resolved/armed below, because `armSession` is what sends the founder's "tap
  // in" SMS. Running the guard second meant a non-executable recommendation still paged the founder
  // and then returned `escalated_recommendation_only` without ever opening a card — the founder
  // walked into an empty cockpit and the session expired untouched (2026-07-20 incident). The
  // decision keys ONLY on the remedy shape, so nothing forces it to happen after arming.
  const { canOfferOneTapApproval } = await import("@/lib/cs-director");
  if (!canOfferOneTapApproval(input.remedy)) {
    await postInternalNote(
      admin,
      input.ticketId,
      `[cs-director] June escalated to the founder with a RECOMMENDATION (not an auto-executable action) — left escalated to owner for a manual ruling; no one-tap approval card (nothing to auto-fire). ${preview.split("\n")[0]}`,
    );
    return { raised: true, via: "escalated_recommendation_only" };
  }

  let session: { id: string; cockpit_token: string | null } | null = null;
  try {
    const { getActiveSession, armSession } = await import("@/lib/god-mode");
    session = await getActiveSession(admin, input.workspaceId);
    if (!session && ownerId) session = await armSession(admin, { workspaceId: input.workspaceId, createdBy: ownerId });
  } catch (e) {
    console.warn("[june-remedy-approval] founder-escalation cockpit resolution failed:", e instanceof Error ? e.message : e);
  }

  if (!session) {
    await postInternalNote(admin, input.ticketId, `[cs-director] June escalated to the founder with a recommendation, but no active cockpit to text — left escalated for manual review. ${preview.split("\n")[0]}`);
    return { raised: true, via: "escalated_no_cockpit" };
  }

  let approvalId: string | undefined;
  try {
    const { openApproval, sendGodModeSMS } = await import("@/lib/god-mode");
    const card = await openApproval(admin, {
      sessionId: session.id,
      workspaceId: input.workspaceId,
      toolName: JUNE_REMEDY_TOOL,
      toolInput: {
        ticket_id: input.ticketId,
        remedy: input.remedy,
        reasoning: input.reasoning,
        action_type: actionType,
        amount_cents: amountCents,
        // Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first § bullet 4 — the live
        // remedy state at approval time, so a bounce-back / audit reader sees the same state the
        // founder had (never a silent stashless card).
        remedy_states: remedyStates,
        raised_at: now,
      },
      preview,
      risk: "decision",
      category: JUNE_FOUNDER_ESCALATION_CATEGORY,
    });
    approvalId = card.id;
    await sendGodModeSMS(admin, { workspaceId: input.workspaceId, kind: "approval", cockpitToken: session.cockpit_token });
  } catch (e) {
    console.warn("[june-remedy-approval] founder-escalation raise/SMS failed:", e instanceof Error ? e.message : e);
  }

  await postInternalNote(admin, input.ticketId, `[cs-director] June escalated to the founder and texted a one-tap approval. ${preview.split("\n")[0]}`);
  return { raised: true, via: "sms_cockpit", approvalId };
}

async function postInternalNote(admin: Admin, ticketId: string, body: string): Promise<void> {
  try {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: body.slice(0, 4000),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * The box-worker ~60s sweep: carry out (or stand down) any June remedy the founder has decided.
 * Selects `june_remedy` cards with a terminal decision (approved/denied) not yet executed
 * (`tool_input.executed_at` null). Idempotent — the executed stamp prevents a re-fire. Best-effort;
 * never throws (returns counts for the caller's log).
 */
export async function executeApprovedJuneRemedies(admin: Admin): Promise<{ executed: number; denied: number }> {
  let executed = 0;
  let denied = 0;
  let rows: Array<{ id: string; workspace_id: string; status: string; tool_input: Record<string, unknown> }> = [];
  try {
    const { data } = await admin
      .from("god_mode_approvals")
      .select("id, workspace_id, status, tool_input")
      .eq("tool_name", JUNE_REMEDY_TOOL)
      .in("status", ["approved", "denied"])
      .limit(50);
    rows = (data as typeof rows | null) ?? [];
  } catch (e) {
    console.warn("[june-remedy-approval] sweep read failed:", e instanceof Error ? e.message : e);
    return { executed, denied };
  }

  for (const row of rows) {
    const ti = row.tool_input ?? {};
    if (ti.executed_at) continue; // already handled
    const ticketId = typeof ti.ticket_id === "string" ? ti.ticket_id : null;
    if (!ticketId) {
      await stampExecuted(admin, row.id, ti, "no_ticket_id");
      continue;
    }
    try {
      if (row.status === "denied") {
        await postInternalNote(
          admin,
          ticketId,
          `[cs-director] Founder DECLINED the refund/credit. No money moved. Ticket left escalated for a human to decide next steps.`,
        );
        denied++;
        await stampExecuted(admin, row.id, ti, "denied");
        continue;
      }
      // approved → execute the parked remedy, then deliver the customer reply.
      const ok = await executeParkedRemedy(admin, {
        workspaceId: row.workspace_id,
        ticketId,
        remedy: (ti.remedy as Record<string, unknown>) ?? {},
        reasoning: typeof ti.reasoning === "string" ? ti.reasoning : "cs-director founder-approved remedy",
      });
      if (ok) executed++;
      await stampExecuted(admin, row.id, ti, ok ? "executed" : "execute_failed");
    } catch (e) {
      console.warn(`[june-remedy-approval] execute failed (approval ${row.id}):`, e instanceof Error ? e.message : e);
      // Do NOT stamp executed on a thrown error — let the next sweep retry.
    }
  }
  return { executed, denied };
}

async function stampExecuted(
  admin: Admin,
  approvalId: string,
  toolInput: Record<string, unknown>,
  outcome: string,
): Promise<void> {
  try {
    await admin
      .from("god_mode_approvals")
      .update({ tool_input: { ...toolInput, executed_at: new Date().toISOString(), execution_outcome: outcome } })
      .eq("id", approvalId);
  } catch (e) {
    console.warn("[june-remedy-approval] stampExecuted failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Execute one founder-approved remedy: run the action through the production executor (execute-then-
 * message invariant — the customer hears nothing until the action verifies), deliver the customer
 * reply in the channel persona, then close+deescalate the ticket. Mirrors handleApproveRemedy's
 * ordering; kept standalone because the sweep has no cs-director job to hang off. Returns true on a
 * clean execute+deliver.
 */
async function executeParkedRemedy(
  admin: Admin,
  input: { workspaceId: string; ticketId: string; remedy: Record<string, unknown>; reasoning: string },
): Promise<boolean> {
  const { planRemedyExecution, buildRemedySonnetDecision, parseBatchEvent, summarizeRemedyBatchOutcome } =
    await import("@/lib/cs-director");
  const planned = planRemedyExecution(input.remedy);
  if (!planned.ok) {
    await postInternalNote(admin, input.ticketId, `[cs-director] Founder approved, but the parked remedy was malformed (${planned.reason}) — not fired. Needs a human.`);
    return false;
  }
  const { data: ticket } = await admin
    .from("tickets")
    .select("customer_id, channel")
    .eq("id", input.ticketId)
    .maybeSingle();
  const customerId = (ticket as { customer_id?: string | null } | null)?.customer_id ?? null;
  const channel = (ticket as { channel?: string | null } | null)?.channel ?? "email";
  if (!customerId) {
    await postInternalNote(admin, input.ticketId, `[cs-director] Founder approved, but the ticket has no customer to act on — not fired. Needs a human.`);
    return false;
  }
  const { data: ws } = await admin.from("workspaces").select("sandbox_mode").eq("id", input.workspaceId).maybeSingle();
  const sandbox = (ws as { sandbox_mode?: boolean } | null)?.sandbox_mode === true;

  const decision = buildRemedySonnetDecision(planned.plan, input.reasoning);
  // Multi-action batch label (Phase 2 of multi-action-remedies) — same as handleApproveRemedy so
  // the founder-approved path surfaces the full fix in one line instead of just actions[0].
  const plannedActionTypes = planned.plan.actions.map((a) => a.actionType);
  const batchLabel =
    plannedActionTypes.length === 1
      ? `action=${plannedActionTypes[0]}`
      : `actions=[${plannedActionTypes.join(", ")}] (${plannedActionTypes.length})`;

  const { executeSonnetDecision } = await import("@/lib/action-executor");
  const suppressedSend = async (): Promise<void> => {
    /* no-op — customer message delivered only after a clean return, below */
  };
  // Capture the executor's per-action sysNote stream so a partial batch (some landed, some failed)
  // is rolled up into ONE partial-batch summary on the failure path (matches handleApproveRemedy's
  // Phase-2 surface). Each raw line still writes to ticket_messages via postInternalNote so the
  // per-line trail is unchanged.
  const batchEvents: ReturnType<typeof parseBatchEvent>[] = [];
  const sysNote = async (msg: string): Promise<void> => {
    const parsed = parseBatchEvent(msg);
    if (parsed) batchEvents.push(parsed);
    await postInternalNote(admin, input.ticketId, `[cs-director/founder-approved] ${msg}`);
  };
  const ctx = { admin, workspaceId: input.workspaceId, ticketId: input.ticketId, customerId, channel, sandbox };
  let res: { escalated: boolean };
  try {
    res = await executeSonnetDecision(ctx as never, decision, null, suppressedSend, sysNote);
  } catch (e) {
    await postInternalNote(
      admin,
      input.ticketId,
      `[cs-director] Founder-approved remedy threw during execution (${e instanceof Error ? e.message : e}). ${batchLabel}. No customer message. Needs a human.`,
    );
    return false;
  }
  if (res.escalated) {
    const summary = summarizeRemedyBatchOutcome(
      plannedActionTypes,
      batchEvents.filter((e): e is NonNullable<typeof e> => e != null),
    );
    await postInternalNote(
      admin,
      input.ticketId,
      `[cs-director] Founder-approved remedy escalated (${summary.oneLine}). ${batchLabel}. No customer message. Needs a human.`,
    );
    return false;
  }

  // Success → EVERY action verified → deliver the customer reply (channel persona, never "June")
  // then close + deescalate. The execute-then-message invariant now applies across the batch: no
  // reply ships until ALL N actions returned success.
  if (planned.plan.customerMessage) {
    try {
      const { deliverTicketMessage } = await import("@/lib/ticket-delivery");
      await deliverTicketMessage(admin, input.workspaceId, input.ticketId, channel, planned.plan.customerMessage, sandbox);
    } catch (e) {
      await postInternalNote(
        admin,
        input.ticketId,
        `[cs-director] Founder-approved remedy fired (${batchLabel}) but the customer reply failed to send (${e instanceof Error ? e.message : e}). Needs a human to re-deliver.`,
      );
      return false;
    }
  }
  try {
    const { closeTicketOnResolvingReply } = await import("@/lib/ticket-directions");
    await closeTicketOnResolvingReply(admin, { workspace_id: input.workspaceId, ticket_id: input.ticketId });
  } catch {
    /* close failure is non-fatal — the action + reply already landed */
  }
  await postInternalNote(
    admin,
    input.ticketId,
    `[cs-director] Founder-approved remedy executed and the customer was updated. ${batchLabel}.`,
  );
  return true;
}
