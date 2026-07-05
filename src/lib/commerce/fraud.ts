/**
 * commerce/fraud.ts — Display ops for fraud posture.
 *
 * Centralizes the historical `from("customer_fraud_status"` reads (i.e. the
 * `src/lib/customer-fraud-status.ts` helper's discriminators) into one SDK
 * module. `getFraudPosture` gathers every fraud case for the customer + the
 * per-workspace resolver flags so an upstream gate stays ONE read away. Underlying
 * table: [[../../docs/brain/tables/fraud_cases]].
 *
 * Ships with zero call-site consumers — the M3 harness compares parity before
 * any surface migrates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { FraudView, FraudPostureView } from "./types";

export type { FraudView, FraudPostureView } from "./types";

const FRAUD_COLUMNS =
  "id, workspace_id, rule_id, rule_type, status, severity, title, summary, evidence, customer_ids, order_ids, orders_held, resolution, first_detected_at, last_seen_at, reviewed_at, created_at";

interface RawFraudRow {
  id: string;
  workspace_id: string;
  rule_id: string | null;
  rule_type: string | null;
  status: string | null;
  severity: string | null;
  title: string | null;
  summary: string | null;
  evidence: Record<string, unknown> | null;
  customer_ids: string[] | null;
  order_ids: string[] | null;
  orders_held: boolean | null;
  resolution: string | null;
  first_detected_at: string;
  last_seen_at: string;
  reviewed_at: string | null;
  created_at: string;
}

function coerceStatus(s: string | null): FraudView["status"] {
  if (s === "reviewing" || s === "confirmed_fraud" || s === "dismissed") return s;
  return "open";
}

function buildFraudView(row: RawFraudRow): FraudView {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    rule_id: row.rule_id,
    rule_type: row.rule_type ?? "",
    status: coerceStatus(row.status),
    severity: row.severity ?? "medium",
    title: row.title ?? "",
    summary: row.summary,
    evidence: row.evidence ?? {},
    customer_ids: Array.isArray(row.customer_ids) ? row.customer_ids : [],
    order_ids: Array.isArray(row.order_ids) ? row.order_ids : [],
    orders_held: Boolean(row.orders_held),
    resolution: row.resolution,
    first_detected_at: row.first_detected_at,
    last_seen_at: row.last_seen_at,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
  };
}

/**
 * Per-customer fraud posture. Reads `fraud_cases` where the customer id appears
 * in `customer_ids`, then rolls the discriminators the orchestrator gate reads
 * (any `confirmed_fraud` status OR any `amazon_reseller` rule_type) into a
 * single view.
 */
export async function getFraudPosture(
  workspaceId: string,
  customerId: string,
): Promise<FraudPostureView> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("fraud_cases")
    .select(FRAUD_COLUMNS)
    .eq("workspace_id", workspaceId)
    .overlaps("customer_ids", [customerId]);
  if (error) throw error;
  const rows = (data ?? []) as RawFraudRow[];
  const cases = rows.map(buildFraudView);

  const is_confirmed_fraud = cases.some((c) => c.status === "confirmed_fraud");
  const is_amazon_reseller = cases.some((c) => c.rule_type === "amazon_reseller");
  const should_block = is_confirmed_fraud || is_amazon_reseller;
  const block_reason = is_confirmed_fraud
    ? "confirmed_fraud"
    : is_amazon_reseller
      ? "amazon_reseller"
      : null;

  return {
    workspace_id: workspaceId,
    customer_id: customerId,
    is_confirmed_fraud,
    is_amazon_reseller,
    is_known_reseller_address: false,
    should_block,
    block_reason,
    cases,
  };
}
