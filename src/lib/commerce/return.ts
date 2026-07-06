/**
 * commerce/return.ts — Display ops for returns.
 *
 * Returns refund on EasyPost `delivered` (not carrier first-scan) and rows we
 * own the refund for are the ones with `easypost_shipment_id NOT NULL` — the
 * `refundableOnly` filter enforces that. See [[../../docs/brain/tables/returns]]
 * § Gotchas.
 *
 * Ships with zero call-site consumers — the M3 harness compares parity before
 * any surface migrates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReturnView, ReturnLineView } from "./types";

export type { ReturnView, ReturnLineView } from "./types";

const RETURN_COLUMNS =
  "id, workspace_id, order_id, order_number, customer_id, status, resolution_type, order_total_cents, label_cost_cents, net_refund_cents, tracking_number, carrier, label_url, easypost_shipment_id, return_line_items, shipped_at, delivered_at, refunded_at, created_at";

interface RawReturnRow {
  id: string;
  workspace_id: string;
  order_id: string | null;
  order_number: string | null;
  customer_id: string | null;
  status: string | null;
  resolution_type: string | null;
  order_total_cents: number | null;
  label_cost_cents: number | null;
  net_refund_cents: number | null;
  tracking_number: string | null;
  carrier: string | null;
  label_url: string | null;
  easypost_shipment_id: string | null;
  return_line_items: unknown;
  shipped_at: string | null;
  delivered_at: string | null;
  refunded_at: string | null;
  created_at: string;
}

function coerceStatus(s: string | null): ReturnView["status"] {
  const allowed: ReturnView["status"][] = [
    "open",
    "label_created",
    "in_transit",
    "delivered",
    "refunded",
    "cancelled",
    "closed",
  ];
  if (s && (allowed as string[]).includes(s)) return s as ReturnView["status"];
  return "open";
}

function coerceResolution(s: string | null): ReturnView["resolution_type"] {
  const allowed: ReturnView["resolution_type"][] = [
    "refund_return",
    "store_credit_return",
    "refund_no_return",
    "store_credit_no_return",
  ];
  if (s && (allowed as string[]).includes(s)) return s as ReturnView["resolution_type"];
  return "refund_return";
}

function buildReturnLines(items: unknown): ReturnLineView[] {
  if (!Array.isArray(items)) return [];
  return (items as Array<Record<string, unknown>>).map((it) => ({
    variant_id: it.variant_id != null ? String(it.variant_id) : null,
    title: typeof it.title === "string" ? it.title : "",
    quantity: Number(it.quantity ?? 1),
    reason: typeof it.reason === "string" ? it.reason : null,
  }));
}

function buildReturnView(row: RawReturnRow): ReturnView {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    order_id: row.order_id,
    order_number: row.order_number ?? "",
    customer_id: row.customer_id,
    status: coerceStatus(row.status),
    resolution_type: coerceResolution(row.resolution_type),
    order_total_cents: Number(row.order_total_cents ?? 0),
    label_cost_cents: Number(row.label_cost_cents ?? 0),
    net_refund_cents: Number(row.net_refund_cents ?? 0),
    tracking_number: row.tracking_number,
    carrier: row.carrier,
    label_url: row.label_url,
    return_line_items: buildReturnLines(row.return_line_items),
    shipped_at: row.shipped_at,
    delivered_at: row.delivered_at,
    refunded_at: row.refunded_at,
    created_at: row.created_at,
  };
}

export interface ReturnListFilters {
  customer_id?: string;
  status?: ReturnView["status"];
  /**
   * When true, only returns rows with `easypost_shipment_id NOT NULL` — i.e.
   * returns we own the refund for. See [[../../docs/brain/tables/returns]] § Gotchas.
   */
  refundableOnly?: boolean;
  page_size?: number;
  max_rows?: number;
}

/**
 * Fetch one return by internal UUID. Throws if the return is missing or not
 * in the given workspace.
 */
export async function getReturn(workspaceId: string, returnId: string): Promise<ReturnView> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("returns")
    .select(RETURN_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", returnId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`getReturn: not found — workspace=${workspaceId} return=${returnId}`);
  return buildReturnView(data as RawReturnRow);
}

/**
 * All returns belonging to one customer. Walks past the 1000-row cap by
 * cursor pagination on `(created_at DESC, id DESC)`. Direct `customer_id`
 * match — link-follow is a caller-side concern.
 */
export async function listReturnsByCustomer(
  workspaceId: string,
  customerId: string,
  filters: Omit<ReturnListFilters, "customer_id"> = {},
): Promise<ReturnView[]> {
  return listReturns(workspaceId, { ...filters, customer_id: customerId });
}

/**
 * List returns we own the refund for — the `easypost_shipment_id NOT NULL`
 * filter enforced at the source. Convenience for the refund pipeline surface.
 */
export async function listRefundableReturns(
  workspaceId: string,
  filters: Omit<ReturnListFilters, "refundableOnly"> = {},
): Promise<ReturnView[]> {
  return listReturns(workspaceId, { ...filters, refundableOnly: true });
}

/**
 * List returns for a workspace with cursor-pagination past the 1000-row cap.
 */
export async function listReturns(
  workspaceId: string,
  filters: ReturnListFilters = {},
): Promise<ReturnView[]> {
  const admin = createAdminClient();
  const pageSize = Math.max(1, Math.min(1000, filters.page_size ?? 500));
  const maxRows = filters.max_rows ?? Number.POSITIVE_INFINITY;

  const out: ReturnView[] = [];
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  while (out.length < maxRows) {
    let q = admin.from("returns").select(RETURN_COLUMNS).eq("workspace_id", workspaceId);
    if (filters.customer_id) q = q.eq("customer_id", filters.customer_id);
    if (filters.status) q = q.eq("status", filters.status);
    if (filters.refundableOnly) q = q.not("easypost_shipment_id", "is", null);
    if (cursorCreatedAt && cursorId) {
      q = q.or(
        `created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`,
      );
    }
    q = q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(pageSize);

    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as RawReturnRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (out.length >= maxRows) break;
      out.push(buildReturnView(row));
    }
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
  }

  return out;
}
