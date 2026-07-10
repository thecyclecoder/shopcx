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

type Admin = ReturnType<typeof createAdminClient>;

/** The remedy action types that MOVE MONEY / issue a credit — the class the founder gate covers. */
export const MONEY_ACTION_TYPES = new Set<string>([
  "partial_refund",
  "redeem_points_as_refund",
  "create_replacement_order",
  "dollar_replacement",
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
 * Pull the money amount (cents) from ONE payload object — the shared shape used by both a legacy
 * single-action remedy (`{action_type, payload}`) and each step in a multi-action remedy's
 * `actions[]`. Checks `amount_cents` first, then `replacement_amount_cents` (dollar_replacement).
 * Returns null when the field is missing / non-finite. Pure.
 */
function extractPayloadAmountCents(payload: Record<string, unknown>): number | null {
  const raw = payload.amount_cents ?? payload.replacement_amount_cents;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null;
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
    lines.push({ actionType, amountCents: extractPayloadAmountCents(payload) });
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
      amountCents: extractPayloadAmountCents(step.actionParams),
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
 * Compose the plain-language card/SMS-context text the founder reads — simple enough to approve at a
 * glance. Two shapes (Phase 3 of multi-action-remedies):
 *  - SINGLE-line (`moneyLines` omitted OR length ≤ 1): renders the legacy string
 *    "Refund $48.00 to Susan on 'Wrong price'?" that prod SMSes + prior tests rely on.
 *  - MULTI-line (`moneyLines` length ≥ 2): names the TOTAL up-front (so a 2×$30 split can't hide
 *    the true spend from the founder) AND lists each money line so the shape of the fix is legible
 *    without opening the tool_input.
 * Pure.
 */
export function buildJuneApprovalPreview(input: {
  actionType: string;
  /** The SUMMED money amount in cents (or null when unknown). */
  amountCents: number | null;
  /** Ordered per-money-action lines. Length ≥ 2 triggers the multi-line format. */
  moneyLines?: MoneyActionLine[];
  customerName?: string | null;
  ticketSubject?: string | null;
  reasoning?: string | null;
}): string {
  const dollars = input.amountCents != null ? `$${(input.amountCents / 100).toFixed(2)}` : "an unspecified amount";
  const who = input.customerName?.trim() ? ` to ${input.customerName.trim()}` : "";
  const subj = input.ticketSubject?.trim() ? ` on "${input.ticketSubject.trim()}"` : "";
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
    return `Approve ${dollars} in refunds/credits${who}${subj}?\n${bullets}${why}`;
  }

  const verb =
    input.actionType === "create_replacement_order" || input.actionType === "dollar_replacement"
      ? "Send a replacement worth"
      : "Refund";
  return `${verb} ${dollars}${who}${subj}?${why}`;
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
  via: "sms_cockpit" | "escalated_no_cockpit";
  approvalId?: string;
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
  const preview = buildJuneApprovalPreview({
    actionType: input.actionType,
    amountCents: input.amountCents,
    moneyLines,
    customerName,
    ticketSubject,
    reasoning: input.reasoning,
  });
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
  const why = input.reasoning?.trim() ? `\n\nJune: ${input.reasoning.trim().slice(0, 500)}` : "";
  return `${action}${subj}?${why}`;
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
  const preview = buildFounderApprovalPreview({ remedy: input.remedy, reasoning: input.reasoning, customerName, ticketSubject });
  const actionType = typeof input.remedy.action_type === "string" ? input.remedy.action_type.trim() : null;
  const amountCents = remedyMoneyAmountCents(input.remedy);
  const ownerId = await resolveOwnerUserId(admin, input.workspaceId);

  let session: { id: string; cockpit_token: string | null } | null = null;
  try {
    const { getActiveSession, armSession } = await import("@/lib/god-mode");
    session = await getActiveSession(admin, input.workspaceId);
    if (!session && ownerId) session = await armSession(admin, { workspaceId: input.workspaceId, createdBy: ownerId });
  } catch (e) {
    console.warn("[june-remedy-approval] founder-escalation cockpit resolution failed:", e instanceof Error ? e.message : e);
  }

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
      toolInput: { ticket_id: input.ticketId, remedy: input.remedy, reasoning: input.reasoning, action_type: actionType, amount_cents: amountCents, raised_at: now },
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
