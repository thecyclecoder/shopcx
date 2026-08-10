/**
 * assisted-purchase-failure-card — Pure builder for the CEO inbox card that the assisted-purchase
 * failure path mints when a `create_subscription` (or `create_order`) action fails at the terminal
 * step of an assisted purchase.
 *
 * Before this shipped (create-subscription-internal-branch-cannot-create-a-subscription Phase 2 —
 * derived from ticket 687b2e7a / Susan Bellamy), a create_subscription failure inside the
 * assisted-purchase playbook OR a director remedy left the ticket `open` with `escalated_to = null`
 * and NO CEO card — a customer who had already consented to buy and saved a card had to keep
 * writing in to get noticed. That surfaced only because Susan kept writing (15 messages, 2 weeks).
 * A purchase a customer has already agreed to must not be able to fail quietly.
 *
 * Shape: the same `dashboard_notifications` `agent_approval_request` surface every other
 * escalate-founder card uses (`buildEscalateFounderCard` in [[cs-director-escalate-founder-card]],
 * `buildAuthorSpecFailureCard` in [[cs-director-author-spec-failure-card]]). Reuses the CEO-card
 * contract from `cs-director-author-spec-emits-machine-runnable-checks` Phase 2 — the founder sees
 * this in the same approvals feed as every other escalation.
 *
 * Kept pure (no DB, no imports from the runtime worker) so the caller can pass the row shape to a
 * straight `dashboard_notifications` insert, and a unit test can exercise every field without a
 * Supabase mock. Reads-only from the input — the caller is responsible for the write.
 *
 * See docs/brain/specs/create-subscription-internal-branch-cannot-create-a-subscription.md Phase 2
 * and [[../../docs/brain/libraries/action-executor.md]] for the failure → escalate + CEO-card
 * contract.
 */

/** The subset of `CreateSubscriptionInput` (billing_interval + billing_interval_count + items) the
 * card body needs to render the "Plan agreed to" line. Kept local to this module so no import from
 * commerce/subscription.ts is required — the runtime shape is duck-typed on the call site. */
export interface AssistedPlanSummary {
  vendor?: string | null;
  billing_interval?: string | null;
  billing_interval_count?: number | null;
  next_billing_date?: string | null;
  items?: Array<{
    variant_id?: string | null;
    title?: string | null;
    quantity?: number | null;
  }> | null;
}

export interface AssistedPurchaseFailureCardInput {
  /** The ticket the assisted-purchase playbook was running on — the card body links back to it. */
  ticketId: string;
  /** Which action failed. `create_subscription` is the case the Phase-2 spec is derived from; the
   *  shape supports `create_order` on the same rail so both terminal effectors escalate uniformly. */
  actionType: "create_subscription" | "create_order";
  /** The customer id — persisted on metadata for surfaces that join by customer. */
  customerId: string;
  /** Customer's first + last (or "customer <id-8>") for a human title/body. Null-safe. */
  customerFirstName?: string | null;
  customerLastName?: string | null;
  customerEmail?: string | null;
  /** The plan the customer agreed to (interval, count, items). Rendered on the body so the founder
   *  sees exactly what to recover without opening the ticket. */
  plan: AssistedPlanSummary;
  /** The concrete failure message from the handler (e.g. the DB error string) — carried verbatim
   *  on the body when present so the founder sees the diagnosis. Null-safe. */
  failureError?: string | null;
  /** Where the failure was observed — `playbook` (assisted-purchase playbook's terminal step) or
   *  `director_remedy` (cs-director's approve_remedy batch). Persisted on metadata + rendered so
   *  the founder can trace which rail escalated. */
  origin: "playbook" | "director_remedy";
  /** The agent_jobs row id whose sysNote / job trail produced this failure — links the card to the
   *  audit trail. Null when the caller isn't running under an agent job (e.g. an inline playbook
   *  execution from unified-ticket-handler). */
  jobId?: string | null;
}

export interface AssistedPurchaseFailureCardRow {
  title: string;
  body: string;
  link: string;
  metadata: {
    routed_to_function: "ceo";
    raised_by_function: "cs";
    escalation_kind: "assisted_purchase_failure";
    /** buildApprovalsFeed reads this as the card summary — names the action + customer + failure. */
    escalation_reason: string;
    ticket_id: string;
    customer_id: string;
    action_type: "create_subscription" | "create_order";
    origin: "playbook" | "director_remedy";
    deep_link: string;
    autonomous: boolean;
    /** so the approvals-feed enrichment can join back to the agent_job row that ran the failure. */
    agent_job_id: string | null;
    /** the concrete handler error string, verbatim. Null when the handler set none. */
    failure_error: string | null;
    /** the plan the customer agreed to, verbatim from the assisted-purchase context, so a downstream
     *  approver / bounce-back handler can pick it up structurally without re-parsing the body. */
    plan: AssistedPlanSummary;
  };
}

function trim(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/** "First Last" / "First" / "customer <id-8>" — never a bare "customer" (the founder must see who). */
export function summarizeCustomer(input: {
  customerId: string;
  customerFirstName?: string | null;
  customerLastName?: string | null;
  customerEmail?: string | null;
}): string {
  const first = trim(input.customerFirstName);
  const last = trim(input.customerLastName);
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  const email = trim(input.customerEmail);
  if (email) return email;
  return `customer ${input.customerId.slice(0, 8)}`;
}

/** "Berry Powder ×1 + Greens ×2 · every 1 month · starts 2026-08-15" — a one-line plan summary. */
export function summarizePlan(plan: AssistedPlanSummary): string {
  const items = Array.isArray(plan.items) ? plan.items : [];
  const itemPart =
    items.length > 0
      ? items
          .map((it) => {
            const title = trim(it?.title ?? null) ?? trim(it?.variant_id ?? null) ?? "item";
            const qty = Number(it?.quantity ?? 1) || 1;
            return qty === 1 ? title : `${title} ×${qty}`;
          })
          .join(" + ")
      : "(no items listed)";
  const interval = trim(plan.billing_interval ?? null);
  const count = Number(plan.billing_interval_count ?? 0);
  const cadence =
    interval && count > 0 ? ` · every ${count} ${interval}${count > 1 ? "s" : ""}` : "";
  const start = trim(plan.next_billing_date ?? null);
  const startPart = start ? ` · starts ${start}` : "";
  return `${itemPart}${cadence}${startPart}`;
}

/**
 * Pure builder — returns the `dashboard_notifications` row shape (title/body/link/metadata) for
 * the CEO inbox card an assisted-purchase failure mints. Deterministic in its inputs — the same
 * inputs always yield the same title/body/metadata, so the test suite can exercise it end-to-end.
 *
 * Title names the customer + action so the approvals feed reads at a glance. Body carries the
 * plan the customer agreed to, the failure origin (playbook / director_remedy), and the concrete
 * error string so the founder sees the diagnosis without opening the ticket. Deep link takes them
 * to the ticket for full context.
 */
export function buildAssistedPurchaseFailureCard(
  input: AssistedPurchaseFailureCardInput,
): AssistedPurchaseFailureCardRow {
  const {
    ticketId,
    actionType,
    customerId,
    plan,
    failureError,
    origin,
    jobId,
  } = input;
  const link = `/dashboard/tickets/${ticketId}`;
  const customerLabel = summarizeCustomer(input);
  const planLine = summarizePlan(plan);
  const actionLabel = actionType === "create_subscription" ? "subscription" : "order";
  const originLabel = origin === "playbook" ? "assisted-purchase playbook" : "cs-director remedy";

  const title = `Assisted-purchase ${actionLabel} FAILED — ${customerLabel}`.slice(0, 200);

  const customerLine = `Customer: ${customerLabel}`;
  const planLineBody = `Plan agreed to: ${planLine}`;
  const originLineBody = `Origin: ${originLabel}`;
  const failureLineBody =
    trim(failureError) !== null
      ? `Failure: ${trim(failureError)}`
      : `Failure: (no error message recorded)`;
  const body = [customerLine, planLineBody, originLineBody, failureLineBody]
    .join("\n")
    .slice(0, 4000);

  const reason = `${actionType} failed via ${originLabel} for ${customerLabel} — ${
    trim(failureError) ?? "no error message"
  }`.slice(0, 2000);

  return {
    title,
    body,
    link,
    metadata: {
      routed_to_function: "ceo",
      raised_by_function: "cs",
      escalation_kind: "assisted_purchase_failure",
      escalation_reason: reason,
      ticket_id: ticketId,
      customer_id: customerId,
      action_type: actionType,
      origin,
      deep_link: link,
      autonomous: true,
      agent_job_id: jobId ?? null,
      failure_error: trim(failureError),
      plan,
    },
  };
}
