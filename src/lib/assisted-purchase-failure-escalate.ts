/**
 * assisted-purchase-failure-escalate — Best-effort side-effect helper for Phase 2 of the
 * create-subscription-internal-branch-cannot-create-a-subscription spec.
 *
 * Wraps two writes both `handleAssistedCreate` (src/lib/playbook-executor.ts) and
 * `handleApproveRemedy` (src/lib/cs-director.ts) must perform when a `create_subscription` /
 * `create_order` action fails at the terminal step of an assisted purchase:
 *
 *   1. Escalate the ticket — `status='open'` + `escalated_at=now()` + `escalation_reason=<why>`,
 *      so the ticket does NOT sit `open` + `escalated_to = null` (the Susan Bellamy state).
 *   2. Insert a CEO `dashboard_notifications` `agent_approval_request` card via the pure builder
 *      in [[assisted-purchase-failure-card]] — same surface the escalate_founder + author_spec
 *      cards use, so the founder sees it in the same approvals feed.
 *
 * Best-effort by design: a failed escalate must NOT swallow the customer-visible response the
 * interpreter returned upstream, and a failed card insert must NOT unwind the escalate. Each
 * side-effect logs on failure and continues.
 *
 * See docs/brain/specs/create-subscription-internal-branch-cannot-create-a-subscription.md Phase 2
 * and [[../../docs/brain/libraries/action-executor.md]] for the failure → escalate + CEO-card
 * contract.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildAssistedPurchaseFailureCard,
  type AssistedPlanSummary,
} from "./assisted-purchase-failure-card";

type Admin = SupabaseClient;

export interface AssistedFailureCustomer {
  id: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

export interface EscalateAndCardInput {
  admin: Admin;
  wsId: string;
  tid: string;
  customer: AssistedFailureCustomer;
  /** The merged params the handler was called with — `vendor`, `items`, `interval`,
   *  `interval_count`, `next_billing_date`. Duck-typed. */
  params: Record<string, unknown>;
  actionType: "create_subscription" | "create_order";
  failureError: string | null;
  origin: "playbook" | "director_remedy";
  jobId?: string | null;
}

function coercePlan(params: Record<string, unknown>): AssistedPlanSummary {
  const items = Array.isArray(params.items)
    ? (params.items as Array<Record<string, unknown>>).map((it) => ({
        variant_id: typeof it?.variant_id === "string" ? it.variant_id : null,
        title: typeof it?.title === "string" ? it.title : null,
        quantity: typeof it?.quantity === "number" ? it.quantity : Number(it?.quantity ?? 1) || 1,
      }))
    : null;
  return {
    vendor: typeof params.vendor === "string" ? params.vendor : null,
    billing_interval:
      typeof params.interval === "string"
        ? params.interval
        : typeof params.billing_interval === "string"
          ? params.billing_interval
          : null,
    billing_interval_count:
      typeof params.interval_count === "number"
        ? params.interval_count
        : typeof params.billing_interval_count === "number"
          ? params.billing_interval_count
          : Number(params.interval_count ?? params.billing_interval_count ?? 0) || null,
    next_billing_date: typeof params.next_billing_date === "string" ? params.next_billing_date : null,
    items,
  };
}

/**
 * Escalate the ticket + insert the CEO card. Best-effort per side-effect — a write failure on
 * either does not throw or swallow the upstream response. Idempotency: the ticket update is
 * scoped by id + workspace and cannot double-escalate a row (escalated_at just refreshes); the
 * card insert is a straight insert and may produce a second card if the caller re-fires the
 * failure — the calling handlers only fire this once per failed action, so no dedupe layer is
 * needed here.
 */
export async function escalateAndCardOnAssistedPurchaseFailure(
  input: EscalateAndCardInput,
): Promise<void> {
  const { admin, wsId, tid, customer, params, actionType, failureError, origin, jobId } = input;

  const plan = coercePlan(params);

  // The director path passes only `customer.id` (its `facts` bag has no name/email); look them up
  // for a human-readable title/body so the founder sees "Susan Bellamy" not "customer 687b2e7a".
  let firstName = customer.first_name ?? null;
  let lastName = customer.last_name ?? null;
  let email = customer.email ?? null;
  if (!firstName && !lastName && !email) {
    try {
      const { data } = await admin
        .from("customers")
        .select("first_name, last_name, email")
        .eq("id", customer.id)
        .maybeSingle();
      if (data) {
        firstName = (data.first_name as string | null) ?? null;
        lastName = (data.last_name as string | null) ?? null;
        email = (data.email as string | null) ?? null;
      }
    } catch (e) {
      console.warn(`[assisted-purchase-failure] customer lookup for ${customer.id} threw:`, e);
    }
  }

  const card = buildAssistedPurchaseFailureCard({
    ticketId: tid,
    actionType,
    customerId: customer.id,
    customerFirstName: firstName,
    customerLastName: lastName,
    customerEmail: email,
    plan,
    failureError,
    origin,
    jobId: jobId ?? null,
  });

  // 1. Escalate the ticket. Compare-and-set on workspace_id + id — a bad workspace scope must
  //    never touch another workspace's row. status='open' + escalated_at=now() is the same shape
  //    outcome-completion-gate.ts + inflection-detector.ts + action-executor.ts write when they
  //    escalate to the AI Routine (idle-triage cron picks it up).
  try {
    const { error: escalateErr } = await admin
      .from("tickets")
      .update({
        status: "open",
        escalated_at: new Date().toISOString(),
        escalation_reason: card.metadata.escalation_reason,
      })
      .eq("id", tid)
      .eq("workspace_id", wsId);
    if (escalateErr) {
      console.warn(
        `[assisted-purchase-failure] escalate ticket ${tid} failed:`,
        escalateErr.message,
      );
    }
  } catch (e) {
    console.warn(`[assisted-purchase-failure] escalate ticket ${tid} threw:`, e);
  }

  // 2. Insert the CEO card. `dashboard_notifications` is workspace-scoped and shape-shared with
  //    every other agent_approval_request card the founder sees.
  try {
    const { error: cardErr } = await admin.from("dashboard_notifications").insert({
      workspace_id: wsId,
      type: "agent_approval_request",
      title: card.title,
      body: card.body,
      link: card.link,
      metadata: card.metadata,
    });
    if (cardErr) {
      console.warn(
        `[assisted-purchase-failure] CEO card insert for ticket ${tid} failed:`,
        cardErr.message,
      );
    }
  } catch (e) {
    console.warn(`[assisted-purchase-failure] CEO card insert for ticket ${tid} threw:`, e);
  }
}
