/**
 * Customer fraud status helpers — used by the orchestrator to refuse
 * actions for confirmed-fraud customers and by the get_fraud_status
 * data tool to give Sonnet visibility into open cases.
 *
 * "Confirmed fraud" means any fraud_case in status='confirmed_fraud'
 * tied to the customer or any linked profile. Once confirmed, the
 * orchestrator stops everything for that customer and returns the
 * canonical refusal message.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FraudStatus {
  isConfirmedFraud: boolean;
  confirmedCases: Array<{
    id: string;
    rule_type: string;
    title: string;
    severity: string;
    confirmed_at: string;
  }>;
  openCases: Array<{
    id: string;
    rule_type: string;
    title: string;
    severity: string;
    first_detected_at: string;
  }>;
}

/**
 * Resolve every customer ID that should be considered "the same person"
 * — the given customer plus every linked profile. Used so a fraud
 * confirmation on one profile gates actions on all of them.
 */
async function expandLinkedCustomerIds(
  admin: SupabaseClient,
  workspaceId: string,
  customerId: string,
): Promise<string[]> {
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (!link?.group_id) return [customerId];

  const { data: groupMembers } = await admin
    .from("customer_links")
    .select("customer_id")
    .eq("workspace_id", workspaceId)
    .eq("group_id", link.group_id);

  const ids = new Set<string>([customerId]);
  for (const m of groupMembers || []) if (m.customer_id) ids.add(m.customer_id);
  return [...ids];
}

export async function getCustomerFraudStatus(
  admin: SupabaseClient,
  workspaceId: string,
  customerId: string | null,
): Promise<FraudStatus> {
  const empty: FraudStatus = { isConfirmedFraud: false, confirmedCases: [], openCases: [] };
  if (!customerId) return empty;

  const ids = await expandLinkedCustomerIds(admin, workspaceId, customerId);

  // fraud_cases.customer_ids is a uuid[] — overlap operator finds any
  // case that has at least one of our customer IDs in its array.
  const { data: cases } = await admin
    .from("fraud_cases")
    .select("id, rule_type, title, severity, status, first_detected_at, last_seen_at, updated_at")
    .eq("workspace_id", workspaceId)
    .overlaps("customer_ids", ids);

  if (!cases?.length) return empty;

  const confirmedCases: FraudStatus["confirmedCases"] = [];
  const openCases: FraudStatus["openCases"] = [];
  for (const c of cases) {
    if (c.status === "confirmed_fraud") {
      confirmedCases.push({
        id: c.id, rule_type: c.rule_type, title: c.title, severity: c.severity,
        confirmed_at: (c.updated_at || c.last_seen_at) as string,
      });
    } else if (c.status === "open") {
      openCases.push({
        id: c.id, rule_type: c.rule_type, title: c.title, severity: c.severity,
        first_detected_at: c.first_detected_at as string,
      });
    }
  }

  return {
    isConfirmedFraud: confirmedCases.length > 0,
    confirmedCases,
    openCases,
  };
}

/**
 * Canonical refusal message when blocking actions for confirmed fraud.
 * Worded plainly — no "we're sorry for the inconvenience" softeners,
 * no offer to escalate, no specifics about what triggered the block.
 */
export const CONFIRMED_FRAUD_REPLY =
  "We're sorry but your account has been flagged for potential fraud.";
