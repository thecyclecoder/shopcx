/**
 * Customer fraud status helpers — used by the orchestrator's pre-flight
 * gate to refuse actions for any customer with fraud signal, and by the
 * get_fraud_cases data tool to give Sonnet visibility into open cases.
 *
 * The gate (`shouldBlockOrchestrator`) returns true if ANY of:
 *   1. any fraud_cases row with status='confirmed_fraud' (any rule_type)
 *   2. any fraud_cases row with rule_type='amazon_reseller' (any status —
 *      including 'open' — being flagged at all is enough to bail)
 *   3. any of the customer's order shipping/billing addresses match an
 *      active known_resellers row
 *
 * See feedback_orchestrator_fraud_gate.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FraudStatus {
  isConfirmedFraud: boolean;
  isResellerFlagged: boolean;          // any amazon_reseller fraud_case (any status)
  hasResellerAddressMatch: boolean;    // an order ships to / is billed to a known_resellers address
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
  matchedResellers: Array<{
    reseller_id: string;
    business_name: string | null;
    matched_via: "shipping" | "billing";
    order_number: string;
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

// Local copy of normalize logic so we don't pull in the SP-API stack
// (the orchestrator runs on every inbound message and we want this
// helper to stay tiny). Mirrors src/lib/known-resellers.ts.
function normalizeReseller(addr: { address1?: string | null; zip?: string | null }): string {
  const street = (addr.address1 || "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/^0+/, "")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\bsuite\b/g, "ste")
    .replace(/\bapartment\b/g, "apt")
    .replace(/\boval\b/g, "ovl")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const zip = (addr.zip || "").slice(0, 5);
  return `${street}|${zip}`;
}

export async function getCustomerFraudStatus(
  admin: SupabaseClient,
  workspaceId: string,
  customerId: string | null,
): Promise<FraudStatus> {
  const empty: FraudStatus = {
    isConfirmedFraud: false,
    isResellerFlagged: false,
    hasResellerAddressMatch: false,
    confirmedCases: [],
    openCases: [],
    matchedResellers: [],
  };
  if (!customerId) return empty;

  const ids = await expandLinkedCustomerIds(admin, workspaceId, customerId);

  // 1 + 2. fraud_cases — confirmed cases AND any amazon_reseller flags
  const { data: cases } = await admin
    .from("fraud_cases")
    .select("id, rule_type, title, severity, status, first_detected_at, last_seen_at, updated_at")
    .eq("workspace_id", workspaceId)
    .overlaps("customer_ids", ids);

  const confirmedCases: FraudStatus["confirmedCases"] = [];
  const openCases: FraudStatus["openCases"] = [];
  let isResellerFlagged = false;
  for (const c of cases || []) {
    if (c.rule_type === "amazon_reseller") isResellerFlagged = true;
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

  // 3. Address match — does any order from this customer (or linked
  // profiles) ship to / get billed at a known_resellers address?
  // Pulls active resellers' normalized forms; pulls every order's
  // ship/bill addresses; compares in JS.
  const matchedResellers: FraudStatus["matchedResellers"] = [];
  let hasResellerAddressMatch = false;
  const { data: resellers } = await admin
    .from("known_resellers")
    .select("id, business_name, normalized_address")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");

  if (resellers?.length) {
    const resellerByNorm = new Map<string, { id: string; business_name: string | null }>();
    for (const r of resellers) {
      if (r.normalized_address) {
        resellerByNorm.set(r.normalized_address, { id: r.id, business_name: r.business_name });
      }
    }

    type Addr = { address1?: string | null; zip?: string | null };
    const { data: orders } = await admin
      .from("orders")
      .select("order_number, shipping_address, billing_address")
      .eq("workspace_id", workspaceId)
      .in("customer_id", ids)
      .not("created_at", "is", null);

    for (const o of orders || []) {
      const ship = o.shipping_address as Addr | null;
      const bill = o.billing_address as Addr | null;
      if (ship?.address1 && ship.zip) {
        const hit = resellerByNorm.get(normalizeReseller(ship));
        if (hit) {
          matchedResellers.push({ reseller_id: hit.id, business_name: hit.business_name, matched_via: "shipping", order_number: o.order_number });
          hasResellerAddressMatch = true;
        }
      }
      if (bill?.address1 && bill.zip) {
        const hit = resellerByNorm.get(normalizeReseller(bill));
        if (hit) {
          matchedResellers.push({ reseller_id: hit.id, business_name: hit.business_name, matched_via: "billing", order_number: o.order_number });
          hasResellerAddressMatch = true;
        }
      }
    }
  }

  return {
    isConfirmedFraud: confirmedCases.length > 0,
    isResellerFlagged,
    hasResellerAddressMatch,
    confirmedCases,
    openCases,
    matchedResellers,
  };
}

/**
 * Should the orchestrator bail on this customer entirely?
 *
 * True when ANY fraud signal is present: a confirmed case, an
 * amazon_reseller flag (any status), or an order whose address
 * matches a known reseller. Caller should send the canonical refusal
 * + escalate the ticket.
 */
export function shouldBlockOrchestrator(s: FraudStatus): boolean {
  return s.isConfirmedFraud || s.isResellerFlagged || s.hasResellerAddressMatch;
}

/**
 * Build a one-line reason string for the system note logged when the
 * gate fires (so agents reviewing escalated tickets can see why).
 */
export function describeBlockReason(s: FraudStatus): string {
  const parts: string[] = [];
  if (s.isConfirmedFraud) {
    parts.push(`${s.confirmedCases.length} confirmed fraud case(s)`);
  }
  if (s.isResellerFlagged) {
    parts.push("amazon_reseller fraud flag on customer");
  }
  if (s.hasResellerAddressMatch) {
    const names = [...new Set(s.matchedResellers.map(m => m.business_name || "(unnamed)"))];
    parts.push(`order address matches reseller(s): ${names.join(", ")}`);
  }
  return parts.join("; ");
}

/**
 * Canonical refusal message when blocking actions for confirmed fraud.
 * Worded plainly — no "we're sorry for the inconvenience" softeners,
 * no offer to escalate, no specifics about what triggered the block.
 */
export const CONFIRMED_FRAUD_REPLY =
  "We're sorry but your account has been flagged for potential fraud.";
