/**
 * fraud-confirm — the one-customer-at-a-time confirmation contract.
 *
 * Phase 3 of fraud-bin-velocity-requires-real-cross-account-link. Confirming
 * fraud must act on EXACTLY one named customer; a case-wide confirm turned a
 * single real fraudster into 8 innocent subscribers refunded, cancelled and
 * banned in one click (bin:414740, Sep 2026). These pure helpers are the
 * boundary both the confirm-fraud route and the fraud-status readers share, so
 * the invariant is enforced in one place and unit-tested without a DB.
 *
 * Covered by src/lib/fraud-confirm-single-customer.test.ts (test:fraud-confirm-single-customer).
 */

export type ConfirmCustomerValidation =
  | { ok: true; customerId: string }
  | { ok: false; status: 400; error: string };

/**
 * Validate the confirm-fraud body against the case. Every step requires a
 * single `customer_id` that is a member of the case's `customer_ids`. The
 * legacy case-wide shapes are rejected: a `customer_ids` (plural) body, a
 * missing id, a non-string/array id, or a customer outside the case.
 */
export function validateConfirmCustomerId(
  body: Record<string, unknown>,
  caseCustomerIds: string[],
): ConfirmCustomerValidation {
  if ("customer_ids" in body) {
    return {
      ok: false,
      status: 400,
      error: "customer_ids is not accepted — confirming fraud acts on one customer at a time; pass a single customer_id.",
    };
  }
  const customerId = body.customer_id;
  if (typeof customerId !== "string" || !customerId) {
    return { ok: false, status: 400, error: "customer_id (single uuid) is required" };
  }
  if (!caseCustomerIds.includes(customerId)) {
    return { ok: false, status: 400, error: "customer_id is not a member of this fraud case" };
  }
  return { ok: true, customerId };
}

/**
 * Dedupe-append a confirmed customer to a case's confirmed_customer_ids. Used
 * by the `complete` step so confirming the same customer twice is idempotent
 * and confirming a second customer never drops the first.
 */
export function appendConfirmedCustomerId(prior: string[], customerId: string): string[] {
  const clean = (prior || []).filter(Boolean);
  return clean.includes(customerId) ? clean : [...clean, customerId];
}

/**
 * The reader predicate: a `status='confirmed_fraud'` case counts as confirmed
 * fraud for a customer ONLY when the case's confirmed_customer_ids overlaps the
 * customer's linked ids. A customer who merely shares a case with a confirmed
 * fraudster (e.g. shared a bank BIN) is NOT confirmed fraud.
 */
export function isCustomerConfirmedFraud(
  confirmedCustomerIds: string[] | null | undefined,
  linkedCustomerIds: string[],
): boolean {
  if (!confirmedCustomerIds?.length) return false;
  const linked = new Set(linkedCustomerIds);
  return confirmedCustomerIds.some((id) => linked.has(id));
}

/**
 * Per-step scoping predicate: keep only the rows that belong to the one
 * customer being confirmed. Mirrors the `.eq("customer_id", customerId)` filter
 * the route applies to subscriptions and orders — only that customer's records
 * are cancelled / refunded.
 */
export function filterToCustomer<T extends { customer_id: string | null }>(
  rows: T[],
  customerId: string,
): T[] {
  return rows.filter((r) => r.customer_id === customerId);
}
