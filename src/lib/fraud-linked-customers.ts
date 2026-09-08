/**
 * Shared resolver for the full set of customer accounts a fraud case
 * covers — the case's own customer_ids, ids pulled out of the evidence
 * blob, PLUS every account linked to any of those via `customer_links`
 * groups.
 *
 * Both the investigate route (which populates the "Customer Accounts"
 * list the operator reads on the fraud detail page) and the
 * confirm-fraud route's ban_customer step MUST call this function, so
 * the list the operator saw and the list that actually gets banned can
 * never drift apart. That single-source-of-truth is the whole point of
 * this module — see docs/brain/specs/confirming-fraud-must-ban-the-whole-linked-cluster.md.
 *
 * Ground truth: fraud case 5182b1dd on 2026-09-07 confirmed against a
 * 21-account list, but only 1 account received portal_banned because
 * the ban step iterated fraud_cases.customer_ids while the operator's
 * screen showed the linked-cluster set. 13 sibling accounts kept
 * ordering for a full day. Never again.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface LinkedCustomersResult {
  /** The case's own customer_ids, plus any customer_id/customers[]
   *  ids extracted from evidence. This is the "seed" set. */
  caseCustomerIds: string[];
  /** The full expanded set — caseCustomerIds unioned with every
   *  customer_links group member. This is what confirm-fraud must ban
   *  and what investigate renders. Deduped, stable ordering. */
  allCustomerIds: string[];
}

/**
 * Resolve the fraud case's full linked-cluster customer id list.
 *
 * Callers pass a service-role admin client because both call sites
 * (investigate GET, confirm-fraud POST) already run with elevated
 * privileges after their own admin-role gate.
 */
export async function resolveFraudCaseLinkedCustomers(
  admin: SupabaseClient,
  fraudCase: { customer_ids: string[] | null; evidence: unknown }
): Promise<LinkedCustomersResult> {
  const caseCustomerIds: string[] = [...(fraudCase.customer_ids || [])];

  const evidence = (fraudCase.evidence || {}) as Record<string, unknown>;
  const evidenceCustomerId = evidence.customer_id;
  if (typeof evidenceCustomerId === "string" && !caseCustomerIds.includes(evidenceCustomerId)) {
    caseCustomerIds.push(evidenceCustomerId);
  }
  if (Array.isArray(evidence.customers)) {
    for (const c of evidence.customers as { customer_id?: string }[]) {
      if (c?.customer_id && !caseCustomerIds.includes(c.customer_id)) {
        caseCustomerIds.push(c.customer_id);
      }
    }
  }

  const allCustomerIds = new Set(caseCustomerIds);
  if (caseCustomerIds.length > 0) {
    const { data: links } = await admin
      .from("customer_links")
      .select("customer_id, group_id")
      .in("customer_id", caseCustomerIds);

    if (links && links.length > 0) {
      const groupIds = [...new Set(links.map((l: { group_id: string }) => l.group_id))];
      const { data: groupMembers } = await admin
        .from("customer_links")
        .select("customer_id")
        .in("group_id", groupIds);
      for (const m of groupMembers || []) {
        allCustomerIds.add((m as { customer_id: string }).customer_id);
      }
    }
  }

  return {
    caseCustomerIds,
    allCustomerIds: [...allCustomerIds],
  };
}
