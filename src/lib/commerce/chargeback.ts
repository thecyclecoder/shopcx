/**
 * commerce/chargeback.ts — Display ops for chargebacks.
 *
 * Centralizes the historical `from("chargebacks"` reads into one SDK module —
 * the underlying table is [[../../docs/brain/tables/chargeback_events]] but
 * every caller consumes the entity-named view here. See
 * [[../../docs/brain/lifecycles/chargeback-pipeline]].
 *
 * Ships with zero call-site consumers — the M3 harness compares parity before
 * any surface migrates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { ChargebackView } from "./types";

export type { ChargebackView } from "./types";

const CHARGEBACK_COLUMNS =
  "id, workspace_id, shopify_dispute_id, shopify_order_id, customer_id, dispute_type, reason, network_reason_code, amount_cents, currency, status, auto_action_taken, auto_action_at, evidence_due_by, evidence_sent_on, finalized_on, fraud_case_id, ticket_id, initiated_at, created_at";

interface RawChargebackRow {
  id: string;
  workspace_id: string;
  shopify_dispute_id: string;
  shopify_order_id: string | null;
  customer_id: string | null;
  dispute_type: string | null;
  reason: string | null;
  network_reason_code: string | null;
  amount_cents: number | null;
  currency: string | null;
  status: string | null;
  auto_action_taken: string | null;
  auto_action_at: string | null;
  evidence_due_by: string | null;
  evidence_sent_on: string | null;
  finalized_on: string | null;
  fraud_case_id: string | null;
  ticket_id: string | null;
  initiated_at: string;
  created_at: string;
}

function coerceStatus(s: string | null): ChargebackView["status"] {
  if (s === "won" || s === "lost") return s;
  return "under_review";
}

function coerceAction(s: string | null): ChargebackView["auto_action_taken"] {
  if (s === "subscriptions_cancelled" || s === "flagged_for_review" || s === "none") return s;
  return null;
}

function buildChargebackView(row: RawChargebackRow): ChargebackView {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    shopify_dispute_id: row.shopify_dispute_id,
    shopify_order_id: row.shopify_order_id,
    customer_id: row.customer_id,
    dispute_type: row.dispute_type ?? "",
    reason: row.reason,
    network_reason_code: row.network_reason_code,
    amount_cents: Number(row.amount_cents ?? 0),
    currency: row.currency ?? "USD",
    status: coerceStatus(row.status),
    auto_action_taken: coerceAction(row.auto_action_taken),
    auto_action_at: row.auto_action_at,
    evidence_due_by: row.evidence_due_by,
    evidence_sent_on: row.evidence_sent_on,
    finalized_on: row.finalized_on,
    fraud_case_id: row.fraud_case_id,
    ticket_id: row.ticket_id,
    initiated_at: row.initiated_at,
    created_at: row.created_at,
  };
}

export interface ChargebackListFilters {
  customer_id?: string;
  status?: ChargebackView["status"];
  page_size?: number;
  max_rows?: number;
}

/**
 * All chargebacks for one customer. Direct `customer_id` match — link-follow
 * is a caller-side concern. Cursor-paginated on `(created_at DESC, id DESC)`.
 */
export async function listChargebacksByCustomer(
  workspaceId: string,
  customerId: string,
): Promise<ChargebackView[]> {
  return listChargebacks(workspaceId, { customer_id: customerId });
}

/**
 * List chargebacks for a workspace with cursor-pagination past the 1000-row
 * cap.
 */
export async function listChargebacks(
  workspaceId: string,
  filters: ChargebackListFilters = {},
): Promise<ChargebackView[]> {
  const admin = createAdminClient();
  const pageSize = Math.max(1, Math.min(1000, filters.page_size ?? 500));
  const maxRows = filters.max_rows ?? Number.POSITIVE_INFINITY;

  const out: ChargebackView[] = [];
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  while (out.length < maxRows) {
    let q = admin
      .from("chargeback_events")
      .select(CHARGEBACK_COLUMNS)
      .eq("workspace_id", workspaceId);
    if (filters.customer_id) q = q.eq("customer_id", filters.customer_id);
    if (filters.status) q = q.eq("status", filters.status);
    if (cursorCreatedAt && cursorId) {
      q = q.or(
        `created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`,
      );
    }
    q = q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(pageSize);

    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as RawChargebackRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (out.length >= maxRows) break;
      out.push(buildChargebackView(row));
    }
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
  }

  return out;
}
