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
 * Extract the money amount (cents) a remedy would move, or null if it's not a money action. Checks
 * `amount_cents` then `replacement_amount_cents` in the remedy payload. Pure.
 */
export function remedyMoneyAmountCents(remedy: Record<string, unknown> | null | undefined): number | null {
  if (!remedy || typeof remedy !== "object") return null;
  const actionType = typeof remedy.action_type === "string" ? remedy.action_type.trim() : "";
  if (!MONEY_ACTION_TYPES.has(actionType)) return null;
  const payload =
    remedy.payload && typeof remedy.payload === "object" && !Array.isArray(remedy.payload)
      ? (remedy.payload as Record<string, unknown>)
      : {};
  const raw = payload.amount_cents ?? payload.replacement_amount_cents;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null;
}

export interface FounderApprovalDecision {
  /** True → do NOT auto-execute; route to the founder. */
  gated: boolean;
  actionType: string | null;
  /** The money amount in cents (null when unknown — an unknown-amount money action is gated too). */
  amountCents: number | null;
}

/**
 * Decide whether a remedy must go to the founder before executing. A money action whose amount is
 * STRICTLY ABOVE the threshold is gated; a money action with an UNKNOWN amount is ALSO gated (never
 * auto-fire a refund we can't size). Non-money actions and sub-threshold refunds run autonomously.
 * Pure.
 */
export function remedyNeedsFounderApproval(
  remedy: Record<string, unknown> | null | undefined,
  thresholdCents: number,
): FounderApprovalDecision {
  if (!remedy || typeof remedy !== "object") return { gated: false, actionType: null, amountCents: null };
  const actionType = typeof remedy.action_type === "string" ? remedy.action_type.trim() : "";
  if (!MONEY_ACTION_TYPES.has(actionType)) return { gated: false, actionType: actionType || null, amountCents: null };
  const amountCents = remedyMoneyAmountCents(remedy);
  // Unknown amount on a money action → gate (conservative). Known amount → gate only when > threshold.
  const gated = amountCents === null || amountCents > thresholdCents;
  return { gated, actionType, amountCents };
}

/**
 * Compose the plain-language card/SMS-context text the founder reads — simple enough to approve at a
 * glance ("Refund $48.00 to Susan on 'Wrong price' — <why>"). Pure.
 */
export function buildJuneApprovalPreview(input: {
  actionType: string;
  amountCents: number | null;
  customerName?: string | null;
  ticketSubject?: string | null;
  reasoning?: string | null;
}): string {
  const dollars = input.amountCents != null ? `$${(input.amountCents / 100).toFixed(2)}` : "an unspecified amount";
  const verb =
    input.actionType === "create_replacement_order" || input.actionType === "dollar_replacement"
      ? "Send a replacement worth"
      : "Refund";
  const who = input.customerName?.trim() ? ` to ${input.customerName.trim()}` : "";
  const subj = input.ticketSubject?.trim() ? ` on "${input.ticketSubject.trim()}"` : "";
  const why = input.reasoning?.trim() ? `\n\nWhy: ${input.reasoning.trim().slice(0, 400)}` : "";
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
  const preview = buildJuneApprovalPreview({
    actionType: input.actionType,
    amountCents: input.amountCents,
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
