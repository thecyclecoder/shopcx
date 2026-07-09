import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Phase 3 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
// The late-tracking count + list previously fetched every candidate row and
// applied isWithinSLA() in JS — PostgREST's 1000-row cap silently truncated
// the source set, so the counted "late" number + paginated list were both
// wrong on any workspace with >1000 candidate orders. All SLA math (and the
// pagination) now lives in public.amplifier_is_late / orders_late_tracking_count
// / orders_late_tracking (supabase/migrations/20261005150000_phase3_order_rpcs.sql).

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const url = new URL(request.url);

  const { data: workspace } = await admin
    .from("workspaces")
    .select("amplifier_tracking_sla_days, amplifier_cutoff_hour, amplifier_cutoff_timezone, amplifier_shipping_days, shopify_myshopify_domain")
    .eq("id", workspaceId)
    .single();

  const slaDays = workspace?.amplifier_tracking_sla_days ?? 1;
  const cutoffHour = workspace?.amplifier_cutoff_hour ?? 11;
  const cutoffTimezone = workspace?.amplifier_cutoff_timezone || "America/Chicago";
  const shippingDays: number[] = workspace?.amplifier_shipping_days || [1, 2, 3, 4, 5];
  const shopifyDomain = workspace?.shopify_myshopify_domain || "";

  const filter = url.searchParams.get("filter") || "all";
  const search = url.searchParams.get("search");
  const sort = url.searchParams.get("sort") || "created_at";
  const order = url.searchParams.get("order") || "desc";
  const limit = parseInt(url.searchParams.get("limit") || "25");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const countsMode = url.searchParams.get("counts") === "true";

  if (countsMode) {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const base = () => admin.from("orders").select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId).not("financial_status", "ilike", "pending");

    // Run all count queries in parallel — each matches its filter query exactly
    const [syncRes, suspRes, transitRes, deliveredRes, refundedRes, awaitingTrackingRes, lateTrackingRpc] = await Promise.all([
      // Sync errors: awaiting tracking criteria + no amplifier UUID + older than 6 hours
      base()
        .eq("financial_status", "paid")
        .or("fulfillment_status.is.null,fulfillment_status.neq.fulfilled")
        .not("tags", "ilike", "%suspicious%")
        .is("amplifier_order_id", null)
        .lt("created_at", sixHoursAgo),
      // Suspicious
      base().ilike("tags", "%suspicious%"),
      // In transit: fulfilled (or partial with tracking) but not delivered
      base().or("fulfillment_status.ilike.fulfilled,amplifier_shipped_at.not.is.null")
        .not("delivery_status", "ilike", "delivered"),
      // Delivered
      base().ilike("delivery_status", "delivered"),
      // Refunded
      base().or("financial_status.ilike.refunded,financial_status.ilike.partially_refunded"),
      // Awaiting tracking: paid + not fulfilled + no 3PL tracking + not suspicious
      base()
        .eq("financial_status", "paid")
        .or("fulfillment_status.is.null,fulfillment_status.neq.fulfilled")
        .is("amplifier_shipped_at", null)
        .not("tags", "ilike", "%suspicious%"),
      // Late tracking: business-day SLA test now runs in SQL (RPC).
      admin.rpc("orders_late_tracking_count", {
        p_workspace: workspaceId,
        p_sla_days: slaDays,
        p_cutoff_hour: cutoffHour,
        p_cutoff_timezone: cutoffTimezone,
        p_shipping_days: shippingDays,
      }),
    ]);

    const lateTracking = Number(lateTrackingRpc.data ?? 0) || 0;
    const awaitingTracking = awaitingTrackingRes.count || 0;

    return NextResponse.json({
      counts: {
        sync_error: syncRes.count || 0,
        suspicious: suspRes.count || 0,
        late_tracking: lateTracking,
        awaiting_tracking: awaitingTracking,
        in_transit: transitRes.count || 0,
        delivered: deliveredRes.count || 0,
        refunded: refundedRes.count || 0,
      },
    });
  }

  // Build query for filtered list
  let query = admin
    .from("orders")
    .select(`
      id, order_number, email, total_cents, currency, financial_status,
      fulfillment_status, line_items, created_at, tags, source_name,
      amplifier_order_id, amplifier_received_at, amplifier_shipped_at,
      amplifier_tracking_number, amplifier_carrier, amplifier_status,
      delivery_status, delivered_at,
      customer_id, shopify_order_id,
      customers(id, email, first_name, last_name)
    `, { count: "exact" })
    .eq("workspace_id", workspaceId)
    .not("financial_status", "ilike", "pending");

  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  // Apply filters
  if (filter === "sync_error") {
    query = query
      .eq("financial_status", "paid")
      .or("fulfillment_status.is.null,fulfillment_status.neq.fulfilled")
      .not("tags", "ilike", "%suspicious%")
      .is("amplifier_order_id", null)
      .lt("created_at", sixHoursAgo);
  } else if (filter === "suspicious") {
    query = query
      .ilike("tags", "%suspicious%");
  } else if (filter === "in_transit") {
    query = query
      .or("fulfillment_status.ilike.fulfilled,amplifier_shipped_at.not.is.null")
      .not("delivery_status", "ilike", "delivered");
  } else if (filter === "delivered") {
    query = query.ilike("delivery_status", "delivered");
  } else if (filter === "refunded") {
    query = query.or("financial_status.ilike.refunded,financial_status.ilike.partially_refunded");
  } else if (filter === "awaiting_tracking") {
    query = query
      .eq("financial_status", "paid")
      .or("fulfillment_status.is.null,fulfillment_status.neq.fulfilled")
      .is("amplifier_shipped_at", null)
      .not("tags", "ilike", "%suspicious%");
  } else if (filter === "late_tracking") {
    query = query
      .not("amplifier_order_id", "is", null)
      .not("amplifier_received_at", "is", null)
      .is("amplifier_shipped_at", null)
      .not("fulfillment_status", "ilike", "fulfilled")
      .eq("financial_status", "paid");
  }

  // Search
  if (search) {
    const { data: matchingCustomers } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .or(`email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`);

    const customerIds = (matchingCustomers || []).map(c => c.id);
    const orderNumberSearch = search.toUpperCase();
    if (customerIds.length > 0) {
      query = query.or(`order_number.ilike.%${orderNumberSearch}%,customer_id.in.(${customerIds.join(",")})`);
    } else {
      query = query.ilike("order_number", `%${orderNumberSearch}%`);
    }
  }

  const validSorts: Record<string, string> = {
    created_at: "created_at",
    order_number: "order_number",
    total_cents: "total_cents",
    fulfillment_status: "fulfillment_status",
  };
  const sortCol = validSorts[sort] || "created_at";

  // Awaiting tracking: paid + not fulfilled (null/partial/unfulfilled) + not suspicious
  if (filter === "awaiting_tracking") {
    query = query
      .eq("financial_status", "paid")
      .or("fulfillment_status.is.null,fulfillment_status.neq.fulfilled")
      .not("tags", "ilike", "%suspicious%")
      .order(sortCol, { ascending: order === "asc" })
      .range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ orders: data || [], total: count || 0 });
  }

  // Late tracking: Amplifier orders past SLA
  if (filter === "late_tracking") {
    // Server-side SLA test + pagination + total_count. Replaces a fetch-all
    // that PostgREST truncated at 1000 and a JS slice() that mispaged when the
    // truncation hit.
    type LateRow = {
      total_count: number | string | null;
      id: string;
      order_number: string | null;
      email: string | null;
      total_cents: number | string | null;
      currency: string | null;
      financial_status: string | null;
      fulfillment_status: string | null;
      line_items: unknown;
      created_at: string | null;
      tags: string | null;
      source_name: string | null;
      amplifier_order_id: string | null;
      amplifier_received_at: string | null;
      amplifier_shipped_at: string | null;
      amplifier_tracking_number: string | null;
      amplifier_carrier: string | null;
      amplifier_status: string | null;
      delivery_status: string | null;
      delivered_at: string | null;
      customer_id: string | null;
      shopify_order_id: string | null;
      customer_email: string | null;
      customer_first_name: string | null;
      customer_last_name: string | null;
    };
    const { data: rpcRows, error: rpcErr } = await admin.rpc("orders_late_tracking", {
      p_workspace: workspaceId,
      p_sla_days: slaDays,
      p_cutoff_hour: cutoffHour,
      p_cutoff_timezone: cutoffTimezone,
      p_shipping_days: shippingDays,
      p_sort: sortCol,
      p_order: order,
      p_limit: limit,
      p_offset: offset,
    });
    if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 });

    const rows = (rpcRows ?? []) as LateRow[];
    const total = rows.length > 0 ? Number(rows[0].total_count ?? 0) || 0 : 0;
    const page = rows.map((r) => ({
      id: r.id,
      order_number: r.order_number,
      email: r.email,
      total_cents: Number(r.total_cents ?? 0) || 0,
      currency: r.currency,
      financial_status: r.financial_status,
      fulfillment_status: r.fulfillment_status,
      line_items: r.line_items,
      created_at: r.created_at,
      tags: r.tags,
      source_name: r.source_name,
      amplifier_order_id: r.amplifier_order_id,
      amplifier_received_at: r.amplifier_received_at,
      amplifier_shipped_at: r.amplifier_shipped_at,
      amplifier_tracking_number: r.amplifier_tracking_number,
      amplifier_carrier: r.amplifier_carrier,
      amplifier_status: r.amplifier_status,
      delivery_status: r.delivery_status,
      delivered_at: r.delivered_at,
      customer_id: r.customer_id,
      shopify_order_id: r.shopify_order_id,
      customers: {
        id: r.customer_id,
        email: r.customer_email,
        first_name: r.customer_first_name,
        last_name: r.customer_last_name,
      },
    }));

    return NextResponse.json({
      orders: page,
      total,
      shopify_domain: shopifyDomain,
    });
  }

  query = query.order(sortCol, { ascending: order === "asc" });
  query = query.range(offset, offset + limit - 1);

  const { data: orders, count, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    orders: orders || [],
    total: count || 0,
    shopify_domain: shopifyDomain,
  });
}
