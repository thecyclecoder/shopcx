/**
 * Name-mismatch signal (billing name differs from the customer's name) — COPIED
 * (engine Phase 1) from `checkNameMismatch` in src/lib/fraud-detector.ts. Legacy
 * stays the parity oracle.
 *
 * Pure: returns the finding (title + evidence exactly as legacy writes them) or
 * null. Case dedupe/insert/event stay in the caller's wiring.
 *
 * LEGACY QUIRK (reproduced on purpose, plan §5 item 4): this reads the billing
 * address in snake_case only (`first_name` / `last_name`). When an order is
 * ingested without billing, `checkOrderForFraud` backfills it from Shopify
 * GraphQL in camelCase (`firstName` / `lastName`) and stores it as-is, so for
 * those orders both snake keys are missing and the rule silently returns null.
 * Fix it in the engine with a version bump after cutover, never during parity.
 */

export interface NameMismatchConfig {
  ignore_last_name_match?: boolean | null;
}

export interface NameMismatchOrder {
  shopify_order_id: string;
  billing_address: unknown;
}

export interface NameMismatchCustomer {
  first_name: string | null;
  last_name: string | null;
}

export interface NameMismatchEvidence {
  billing_name: string;
  customer_name: string;
  billing_first: string;
  billing_last: string;
  customer_first: string;
  customer_last: string;
  last_names_match: boolean;
  order_id: string;
}

export interface NameMismatchFinding {
  title: string;
  evidence: NameMismatchEvidence;
  /** Legacy dedupes on rule + `evidence->>order_id` among non-closed cases. */
  dedupeKey: string;
}

export function evaluateNameMismatch(
  order: NameMismatchOrder,
  customer: NameMismatchCustomer,
  config: NameMismatchConfig | null | undefined,
): NameMismatchFinding | null {
  // Quirk: snake_case only — a camelCase billing address reads as "no name".
  const billing = order.billing_address as { first_name?: string; last_name?: string } | null;
  if (!billing?.first_name && !billing?.last_name) return null;
  if (!customer.first_name && !customer.last_name) return null;

  const billingFirst = (billing?.first_name || "").toLowerCase().trim();
  const billingLast = (billing?.last_name || "").toLowerCase().trim();
  const customerFirst = (customer.first_name || "").toLowerCase().trim();
  const customerLast = (customer.last_name || "").toLowerCase().trim();

  if (billingFirst === customerFirst && billingLast === customerLast) return null;

  // Same last name may be a spouse/family member when the rule is configured so.
  if (config?.ignore_last_name_match && billingLast === customerLast && billingLast.length > 0) return null;

  const billingName = `${billing?.first_name || ""} ${billing?.last_name || ""}`.trim();
  const customerName = `${customer.first_name || ""} ${customer.last_name || ""}`.trim();

  return {
    title: `Billing name "${billingName}" ≠ customer "${customerName}" on order #${order.shopify_order_id}`,
    evidence: {
      billing_name: billingName,
      customer_name: customerName,
      billing_first: billing?.first_name || "",
      billing_last: billing?.last_name || "",
      customer_first: customer.first_name || "",
      customer_last: customer.last_name || "",
      last_names_match: billingLast === customerLast,
      order_id: order.shopify_order_id,
    },
    dedupeKey: `order:${order.shopify_order_id}:name_mismatch`,
  };
}
