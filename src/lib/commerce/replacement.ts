/**
 * commerce/replacement.ts — Display ops for replacements.
 *
 * A replacement is created from a source order and can adjust the linked
 * subscription's next billing date — that side effect belongs on the Mutation
 * op, not on any surface. See [[../../docs/brain/libraries/replacement-order]].
 *
 * Ships with zero call-site consumers — the M3 harness compares parity before
 * any surface migrates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReplacementView } from "./types";

export type { ReplacementView } from "./types";

const REPLACEMENT_COLUMNS =
  "id, workspace_id, customer_id, original_order_id, original_order_number, replacement_order_id, subscription_id, reason, reason_detail, status, customer_error, items, address_validated, subscription_adjusted, new_next_billing_date, created_at";

interface RawReplacementRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  original_order_id: string | null;
  original_order_number: string | null;
  replacement_order_id: string | null;
  subscription_id: string | null;
  reason: string | null;
  reason_detail: string | null;
  status: string | null;
  customer_error: boolean | null;
  items: unknown;
  address_validated: boolean | null;
  subscription_adjusted: boolean | null;
  new_next_billing_date: string | null;
  created_at: string;
}

function coerceStatus(s: string | null): ReplacementView["status"] {
  const allowed: ReplacementView["status"][] = ["pending", "shipped", "delivered", "cancelled"];
  if (s && (allowed as string[]).includes(s)) return s as ReplacementView["status"];
  return "pending";
}

function buildItems(items: unknown): ReplacementView["items"] {
  if (!Array.isArray(items)) return [];
  return (items as Array<Record<string, unknown>>).map((it) => ({
    variant_id: it.variant_id != null ? String(it.variant_id) : null,
    title: typeof it.title === "string" ? it.title : "",
    quantity: Number(it.quantity ?? 1),
  }));
}

function buildReplacementView(row: RawReplacementRow): ReplacementView {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    customer_id: row.customer_id,
    original_order_id: row.original_order_id,
    original_order_number: row.original_order_number,
    replacement_order_id: row.replacement_order_id,
    subscription_id: row.subscription_id,
    reason: row.reason ?? "",
    reason_detail: row.reason_detail,
    status: coerceStatus(row.status),
    customer_error: Boolean(row.customer_error),
    items: buildItems(row.items),
    address_validated: Boolean(row.address_validated),
    subscription_adjusted: Boolean(row.subscription_adjusted),
    new_next_billing_date: row.new_next_billing_date,
    created_at: row.created_at,
  };
}

export interface ReplacementListFilters {
  customer_id?: string;
  status?: ReplacementView["status"];
  page_size?: number;
  max_rows?: number;
}

/**
 * Fetch one replacement by internal UUID. Throws if the replacement is
 * missing or not in the given workspace.
 */
export async function getReplacement(
  workspaceId: string,
  replacementId: string,
): Promise<ReplacementView> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("replacements")
    .select(REPLACEMENT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", replacementId)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new Error(
      `getReplacement: not found — workspace=${workspaceId} replacement=${replacementId}`,
    );
  return buildReplacementView(data as RawReplacementRow);
}

/**
 * All replacements belonging to one customer. Walks past the 1000-row cap via
 * cursor pagination on `(created_at DESC, id DESC)`. Direct `customer_id`
 * match — link-follow is a caller-side concern.
 */
export async function listReplacementsByCustomer(
  workspaceId: string,
  customerId: string,
): Promise<ReplacementView[]> {
  return listReplacements(workspaceId, { customer_id: customerId });
}

/**
 * List replacements for a workspace with cursor-pagination past the 1000-row
 * cap.
 */
export async function listReplacements(
  workspaceId: string,
  filters: ReplacementListFilters = {},
): Promise<ReplacementView[]> {
  const admin = createAdminClient();
  const pageSize = Math.max(1, Math.min(1000, filters.page_size ?? 500));
  const maxRows = filters.max_rows ?? Number.POSITIVE_INFINITY;

  const out: ReplacementView[] = [];
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  while (out.length < maxRows) {
    let q = admin.from("replacements").select(REPLACEMENT_COLUMNS).eq("workspace_id", workspaceId);
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
    const rows = (data ?? []) as RawReplacementRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (out.length >= maxRows) break;
      out.push(buildReplacementView(row));
    }
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
  }

  return out;
}
