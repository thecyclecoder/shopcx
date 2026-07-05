/**
 * commerce/order.ts — Display ops for orders.
 *
 * An order is a historical record — pricing is snapshotted at renewal time onto
 * the row's line items, so the Display op reads them as-is and does NOT re-price
 * through `./price.ts`. Cursor pagination on `(created_at DESC, id DESC)` walks
 * past PostgREST's 1000-row cap per the goal's "no silent truncation" invariant
 * ([[../../docs/brain/README]] § Probing technique).
 *
 * Ships with zero call-site consumers — the M3 harness compares parity before
 * any surface migrates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { OrderView, OrderLineView } from "./types";

export type { OrderView, OrderLineView } from "./types";

const ORDER_COLUMNS =
  "id, workspace_id, customer_id, subscription_id, order_number, email, currency, financial_status, fulfillment_status, delivery_status, total_cents, line_items, fulfillments, shipping_address, billing_address, created_at, delivered_at, tags, order_type, discount_codes";

interface RawOrderRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  order_number: string | null;
  email: string | null;
  currency: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  delivery_status: string | null;
  total_cents: number | null;
  line_items: unknown;
  fulfillments: unknown;
  shipping_address: Record<string, unknown> | null;
  billing_address: Record<string, unknown> | null;
  created_at: string;
  delivered_at: string | null;
  tags: string | null;
  order_type: string | null;
  discount_codes: unknown;
}

interface RawLineItem {
  variant_id?: string | number | null;
  product_id?: string | number | null;
  title?: string;
  quantity?: number;
  price?: string | number | null;
  price_cents?: number | null;
  total_cents?: number | null;
}

function centsFromLine(l: RawLineItem): { unit: number; total: number } {
  const qty = Number(l.quantity ?? 1);
  const unit =
    typeof l.price_cents === "number" && Number.isFinite(l.price_cents)
      ? l.price_cents
      : typeof l.price === "number"
        ? Math.round(l.price * 100)
        : typeof l.price === "string" && l.price
          ? Math.round(Number(l.price) * 100)
          : 0;
  const total =
    typeof l.total_cents === "number" && Number.isFinite(l.total_cents) ? l.total_cents : unit * qty;
  return { unit, total };
}

function buildOrderView(row: RawOrderRow): OrderView {
  const rawLines = Array.isArray(row.line_items) ? (row.line_items as RawLineItem[]) : [];
  const lines: OrderLineView[] = rawLines.map((l) => {
    const { unit, total } = centsFromLine(l);
    return {
      variant_id: l.variant_id != null ? String(l.variant_id) : null,
      product_id: l.product_id != null ? String(l.product_id) : null,
      title: l.title ?? "",
      quantity: Number(l.quantity ?? 1),
      unit_cents: unit,
      total_cents: total,
    };
  });

  const fulfillments = Array.isArray(row.fulfillments)
    ? (row.fulfillments as Array<Record<string, unknown>>)
    : [];
  const firstFulfillment = fulfillments[0] || {};
  const tracking =
    typeof firstFulfillment.tracking_number === "string"
      ? firstFulfillment.tracking_number
      : typeof firstFulfillment.tracking_numbers === "object" &&
          Array.isArray(firstFulfillment.tracking_numbers) &&
          firstFulfillment.tracking_numbers.length > 0
        ? String((firstFulfillment.tracking_numbers as unknown[])[0])
        : null;
  const carrier =
    typeof firstFulfillment.tracking_company === "string" ? firstFulfillment.tracking_company : null;

  return {
    id: row.id,
    workspace_id: row.workspace_id,
    customer_id: row.customer_id,
    subscription_id: row.subscription_id,
    order_number: row.order_number ?? "",
    email: row.email,
    currency: row.currency ?? "USD",
    financial_status: row.financial_status,
    fulfillment_status: row.fulfillment_status,
    delivery_status: row.delivery_status,
    total_cents: Number(row.total_cents ?? 0),
    tax_cents: 0,
    shipping_cents: 0,
    shipping_protection_added: false,
    shipping_protection_amount_cents: 0,
    line_items: lines,
    fulfillments,
    tracking_number: tracking,
    carrier,
    shipping_address: row.shipping_address,
    billing_address: row.billing_address,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
  };
}

/** Filters accepted by `listOrders`. Any subset is optional. */
export interface OrderListFilters {
  customer_id?: string;
  subscription_id?: string;
  financial_status?: string;
  fulfillment_status?: string;
  order_type?: string;
  /** Per-page ceiling on the RPC's returned rows. Defaults to 500. */
  page_size?: number;
  /** Hard cap on the total rows walked. Defaults to Infinity. */
  max_rows?: number;
}

/**
 * Fetch one order by internal UUID, priced-for-display.
 * Throws if the order is missing or not in the given workspace.
 */
export async function getOrder(workspaceId: string, orderId: string): Promise<OrderView> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`getOrder: not found — workspace=${workspaceId} order=${orderId}`);
  return buildOrderView(data as RawOrderRow);
}

/**
 * All orders belonging to one customer, priced for display. Walks past the
 * 1000-row cap via the same cursor pagination as `listOrders`. Direct
 * `customer_id` match — link-follow is a caller-side concern.
 */
export async function listOrdersByCustomer(
  workspaceId: string,
  customerId: string,
): Promise<OrderView[]> {
  return listOrders(workspaceId, { customer_id: customerId });
}

/**
 * List orders for a workspace with cursor-pagination past the 1000-row cap.
 * Cursor on `(created_at DESC, id DESC)` — matches the goal's "no silent
 * truncation" invariant.
 */
export async function listOrders(
  workspaceId: string,
  filters: OrderListFilters = {},
): Promise<OrderView[]> {
  const admin = createAdminClient();
  const pageSize = Math.max(1, Math.min(1000, filters.page_size ?? 500));
  const maxRows = filters.max_rows ?? Number.POSITIVE_INFINITY;

  const out: OrderView[] = [];
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  while (out.length < maxRows) {
    let q = admin.from("orders").select(ORDER_COLUMNS).eq("workspace_id", workspaceId);
    if (filters.customer_id) q = q.eq("customer_id", filters.customer_id);
    if (filters.subscription_id) q = q.eq("subscription_id", filters.subscription_id);
    if (filters.financial_status) q = q.eq("financial_status", filters.financial_status);
    if (filters.fulfillment_status) q = q.eq("fulfillment_status", filters.fulfillment_status);
    if (filters.order_type) q = q.eq("order_type", filters.order_type);
    if (cursorCreatedAt && cursorId) {
      q = q.or(
        `created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`,
      );
    }
    q = q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(pageSize);

    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as RawOrderRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (out.length >= maxRows) break;
      out.push(buildOrderView(row));
    }

    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
  }

  return out;
}
