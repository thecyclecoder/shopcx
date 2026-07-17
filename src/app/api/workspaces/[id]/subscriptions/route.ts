import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Phase 2 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
// The prior implementation carried two correctness bugs the audit flagged:
//   1. `?products=` pre-filter fetched every subscription in the workspace and
//      containment-checked in JS — PostgREST's 1000-row cap silently truncated
//      the source set, so filtered results and `total` missed matches past 1000.
//   2. `query.range()` ran BEFORE the dunning join + recovery filter, so with
//      `?recovery=…` set the response's rows + total only reflected the current
//      page, not the full filtered population.
// The route now routes every filter (status, payment, product, search,
// recovery) + sort + pagination through public.list_subscriptions, which does
// the items @> containment on idx_subscriptions_items_gin, derives
// recovery_status via a LATERAL join to the latest dunning_cycles row per
// contract, and applies pagination LAST. Response shape is preserved.

type ListSubRow = {
  total_count: number | string | null;
  id: string;
  shopify_contract_id: string | null;
  shopify_customer_id: string | null;
  status: string | null;
  items: Array<{ price_cents?: number; quantity?: number; product_id?: string }> | null;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  last_payment_status: string | null;
  delivery_price_cents: number | string | null;
  created_at: string | null;
  updated_at: string | null;
  customer_id: string | null;
  customer_email: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  recovery_status: string | null;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const url = new URL(request.url);

  const status = url.searchParams.get("status");
  const recovery = url.searchParams.get("recovery");
  const payment = url.searchParams.get("payment");
  const search = url.searchParams.get("search");
  const productIdsRaw = url.searchParams.get("products");
  const sort = url.searchParams.get("sort") || "next_billing_date";
  const order = url.searchParams.get("order") || "asc";
  const limit = parseInt(url.searchParams.get("limit") || "25");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const productIds = productIdsRaw
    ? productIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const { data: rows, error } = await admin.rpc("list_subscriptions", {
    p_workspace: workspaceId,
    p_status: status,
    p_payment: payment,
    p_recovery: recovery,
    p_search: search,
    p_product_ids: productIds,
    p_sort: sort,
    p_order: order,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const list = ((rows ?? []) as ListSubRow[]);
  const total = list.length > 0 ? Number(list[0].total_count ?? 0) || 0 : 0;

  const subscriptions = list.map((r) => {
    const items = r.items ?? [];
    const totalCents = items.reduce(
      (sum, i) => sum + ((i.price_cents || 0) * (i.quantity || 1)),
      0,
    );
    const interval = r.billing_interval || "month";
    const intervalCount = r.billing_interval_count || 1;
    let mrr_cents = totalCents;
    if (interval === "year") mrr_cents = Math.round(totalCents / (12 * intervalCount));
    else if (interval === "week") mrr_cents = Math.round(totalCents * (4.33 / intervalCount));
    else if (interval === "day") mrr_cents = Math.round(totalCents * (30 / intervalCount));
    else mrr_cents = Math.round(totalCents / intervalCount);

    return {
      id: r.id,
      shopify_contract_id: r.shopify_contract_id,
      shopify_customer_id: r.shopify_customer_id,
      status: r.status,
      items,
      billing_interval: r.billing_interval,
      billing_interval_count: r.billing_interval_count,
      next_billing_date: r.next_billing_date,
      last_payment_status: r.last_payment_status,
      delivery_price_cents: Number(r.delivery_price_cents ?? 0) || 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
      customer_id: r.customer_id,
      customers: {
        id: r.customer_id,
        email: r.customer_email,
        first_name: r.customer_first_name,
        last_name: r.customer_last_name,
      },
      recovery_status: r.recovery_status,
      mrr_cents,
    };
  });

  return NextResponse.json({ subscriptions, total });
}
