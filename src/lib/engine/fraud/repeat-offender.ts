/**
 * Repeat-offender ("confirmed fraud similarity") matching — COPIED (engine
 * Phase 1) from the confirmed-fraud block of `checkOrderForFraudInner` in
 * src/lib/fraud-detector.ts. Legacy stays the parity oracle.
 *
 * Compares an incoming order against orders of INDIVIDUALLY-CONFIRMED fraud
 * customers and returns the same match objects (same `type` strings, same
 * `this_value` / `fraud_value` formatting, same dedupe) legacy stores in
 * `fraud_cases.evidence.matches`. Loading confirmed cases/orders, the case
 * insert and the `fraud/case.created` event stay in the caller's wiring.
 *
 * Match types (legacy numbers them 1–9, with 5 being a ship/bill cross pair):
 *   gmail_alias · exact_email · shipping_address · billing_address ·
 *   ship_to_fraud_billing · bill_to_fraud_shipping ·
 *   same_lastname_same_address · same_name · same_email_domain · fuzzy_name
 * There is NO phone match in legacy.
 *
 * Legacy quirks reproduced on purpose (fix after cutover, with a version bump):
 *  - Dedupe key is `${type}:${fraud_order}` using the fraud order's
 *    `order_number`; two different confirmed orders with a null/empty
 *    order_number collapse into one match per type.
 *  - `fuzzy_name` is checked on shipping then billing; dedupe keeps the
 *    shipping one when both fire for the same fraud order.
 *  - `same_email_domain` takes the text after the FIRST "@" (`split("@")[1]`),
 *    unlike `emailDomain` (last "@"), and does not strip a "+alias".
 *  - `fraud_case_id` is the FIRST confirmed case whose `order_ids` contains the
 *    fraud order (cases are in caller/DB order), "" if none.
 */
import { FREEMAIL_DOMAINS } from "./freemail";
import { firstNameOverlap } from "./names";

export type RepeatOffenderMatchType =
  | "gmail_alias"
  | "exact_email"
  | "shipping_address"
  | "billing_address"
  | "ship_to_fraud_billing"
  | "bill_to_fraud_shipping"
  | "same_lastname_same_address"
  | "same_name"
  | "same_email_domain"
  | "fuzzy_name";

export interface RepeatOffenderMatch {
  type: RepeatOffenderMatchType;
  this_value: string;
  fraud_value: string;
  fraud_order: string;
  fraud_case_id: string;
}

/** Shopify address JSON in either camelCase (GraphQL) or snake_case (REST/stored). */
type LooseAddress = Record<string, string> | null;

export interface RepeatOffenderOrder {
  email: string | null;
  shipping_address: unknown;
  billing_address: unknown;
}

export interface ConfirmedFraudOrder {
  id: string;
  order_number: string | null;
  email: string | null;
  customer_id: string | null;
  shipping_address: unknown;
  billing_address: unknown;
}

export interface ConfirmedFraudCase {
  id: string;
  order_ids: string[] | null;
  confirmed_customer_ids: string[] | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep only values that look like an internal order UUID (copy of legacy `orderUuids`). */
export function orderUuids(ids: unknown[]): string[] {
  const out: string[] = [];
  for (const v of ids) {
    if (typeof v === "string" && UUID_RE.test(v)) out.push(v);
  }
  return out;
}

/** Order ids to load for repeat-offender matching: every case's order_ids, UUIDs only. */
export function confirmedFraudOrderIds(cases: ConfirmedFraudCase[]): string[] {
  return orderUuids(cases.flatMap((c) => c.order_ids || []));
}

/**
 * Keep only orders whose customer was individually confirmed in some case
 * (`confirmed_customer_ids`). An order that merely shares a case (e.g. a common
 * bank BIN) with a confirmed fraudster must not seed a match.
 */
export function filterToConfirmedCustomers<T extends { customer_id: string | null }>(
  cases: ConfirmedFraudCase[],
  orders: T[],
): T[] {
  const confirmed = new Set<string>(cases.flatMap((c) => (c.confirmed_customer_ids || []) as string[]).filter(Boolean));
  return orders.filter((o) => o.customer_id && confirmed.has(o.customer_id));
}

const lc = (s: string | undefined | null) => (s || "").toLowerCase().trim();
const street = (a: LooseAddress) => (a?.address1 || "").toLowerCase().replace(/[.,#]/g, "").trim();

/**
 * All repeat-offender matches between `order` and `confirmedFraudOrders`,
 * deduped by type + fraud order number (first wins). Pass orders already
 * narrowed with `filterToConfirmedCustomers`; `confirmedCases` is used only to
 * resolve each match's `fraud_case_id`.
 */
export function matchRepeatOffender(
  order: RepeatOffenderOrder,
  confirmedFraudOrders: ConfirmedFraudOrder[],
  confirmedCases: ConfirmedFraudCase[] = [],
): RepeatOffenderMatch[] {
  const matches: RepeatOffenderMatch[] = [];
  const shipping = order.shipping_address as LooseAddress;
  const billing = order.billing_address as LooseAddress;
  const email = (order.email || "").toLowerCase().trim();
  const emailBase = email.replace(/\+[^@]*@/, "@"); // strip gmail alias
  const shipFirst = lc(shipping?.firstName || shipping?.first_name);
  const shipLast = lc(shipping?.lastName || shipping?.last_name);
  const billFirst = lc(billing?.firstName || billing?.first_name);
  const billLast = lc(billing?.lastName || billing?.last_name);
  const shipAddr1 = street(shipping);
  const billAddr1 = street(billing);
  const shipZip = (shipping?.zip || "").trim();
  const billZip = (billing?.zip || "").trim();

  for (const fo of confirmedFraudOrders) {
    const fraudCase = confirmedCases.find((c) => c.order_ids?.includes(fo.id));
    const caseId = fraudCase?.id || "";
    // Legacy types this as `string`; a null order_number passes through as-is.
    const fraudOrder = fo.order_number as string;
    const foShip = fo.shipping_address as LooseAddress;
    const foBill = fo.billing_address as LooseAddress;
    const foEmail = (fo.email || "").toLowerCase().trim();
    const foEmailBase = foEmail.replace(/\+[^@]*@/, "@");
    const foShipFirst = lc(foShip?.firstName || foShip?.first_name);
    const foShipLast = lc(foShip?.lastName || foShip?.last_name);
    const foBillFirst = lc(foBill?.firstName || foBill?.first_name);
    const foBillLast = lc(foBill?.lastName || foBill?.last_name);
    const foShipAddr1 = street(foShip);
    const foBillAddr1 = street(foBill);
    const foShipZip = (foShip?.zip || "").trim();
    const foBillZip = (foBill?.zip || "").trim();

    const push = (type: RepeatOffenderMatchType, thisValue: string, fraudValue: string) =>
      matches.push({ type, this_value: thisValue, fraud_value: fraudValue, fraud_order: fraudOrder, fraud_case_id: caseId });

    // 1. Gmail alias (same base email, different full email)
    if (emailBase && foEmailBase && emailBase === foEmailBase && email !== foEmail) {
      push("gmail_alias", email, foEmail);
    }
    // 2. Exact email
    if (email && foEmail && email === foEmail) {
      push("exact_email", email, foEmail);
    }
    // 3. Shipping address (same street + zip)
    if (shipAddr1 && shipZip && foShipAddr1 && foShipZip && shipAddr1 === foShipAddr1 && shipZip === foShipZip) {
      push("shipping_address", `${shipAddr1}, ${shipZip}`, `${foShipAddr1}, ${foShipZip}`);
    }
    // 4. Billing address
    if (billAddr1 && billZip && foBillAddr1 && foBillZip && billAddr1 === foBillAddr1 && billZip === foBillZip) {
      push("billing_address", `${billAddr1}, ${billZip}`, `${foBillAddr1}, ${foBillZip}`);
    }
    // 5. Cross-match: this shipping = fraud billing, or vice versa
    if (shipAddr1 && shipZip && foBillAddr1 && foBillZip && shipAddr1 === foBillAddr1 && shipZip === foBillZip) {
      push("ship_to_fraud_billing", `${shipAddr1}, ${shipZip}`, `${foBillAddr1}, ${foBillZip}`);
    }
    if (billAddr1 && billZip && foShipAddr1 && foShipZip && billAddr1 === foShipAddr1 && billZip === foShipZip) {
      push("bill_to_fraud_shipping", `${billAddr1}, ${billZip}`, `${foShipAddr1}, ${foShipZip}`);
    }
    // 6. Same last name + same street (zip not compared)
    if (shipLast && foShipLast && shipLast === foShipLast && shipAddr1 && foShipAddr1 && shipAddr1 === foShipAddr1) {
      push("same_lastname_same_address", `${shipFirst} ${shipLast} @ ${shipAddr1}`, `${foShipFirst} ${foShipLast} @ ${foShipAddr1}`);
    }
    // 7. Same first + last shipping name
    if (shipFirst && shipLast && foShipFirst && foShipLast && shipFirst === foShipFirst && shipLast === foShipLast) {
      push("same_name", `${shipFirst} ${shipLast}`, `${foShipFirst} ${foShipLast}`);
    }
    // 8. Same custom (non-freemail) email domain, different email
    const dom = email.split("@")[1] || "";
    const foDom = foEmail.split("@")[1] || "";
    if (dom && dom === foDom && email !== foEmail && !FREEMAIL_DOMAINS.has(dom)) {
      push("same_email_domain", email, foEmail);
    }
    // 9. Fuzzy name — same last name + overlapping first name ("stephen" → "benstephen")
    if (shipLast && foShipLast && shipLast === foShipLast && firstNameOverlap(shipFirst, foShipFirst)) {
      push("fuzzy_name", `${shipFirst} ${shipLast}`, `${foShipFirst} ${foShipLast}`);
    }
    if (billLast && foBillLast && billLast === foBillLast && firstNameOverlap(billFirst, foBillFirst)) {
      push("fuzzy_name", `${billFirst} ${billLast}`, `${foBillFirst} ${foBillLast}`);
    }
  }

  // Dedupe by type + fraud order number (first wins)
  const seen = new Set<string>();
  return matches.filter((m) => {
    const key = `${m.type}:${m.fraud_order}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Case summary + linked case ids, worded exactly as legacy writes them. */
export function summarizeRepeatOffenderMatches(matches: RepeatOffenderMatch[]): {
  matchSummary: string;
  linkedCaseIds: string[];
  summary: string;
} {
  const matchSummary = matches
    .map((m) => `${m.type}: "${m.this_value}" matches fraud order ${m.fraud_order} ("${m.fraud_value}")`)
    .join("; ");
  const linkedCaseIds = [...new Set(matches.map((m) => m.fraud_case_id).filter(Boolean))];
  return {
    matchSummary,
    linkedCaseIds,
    summary: `Order linked to ${linkedCaseIds.length} confirmed fraud case(s): ${matchSummary}`,
  };
}

/** Legacy case title for a repeat-offender match. */
export function repeatOffenderTitle(orderNumber: string | null, shopifyOrderId: string | null): string {
  return `Order ${orderNumber || shopifyOrderId} matches confirmed fraud`;
}
