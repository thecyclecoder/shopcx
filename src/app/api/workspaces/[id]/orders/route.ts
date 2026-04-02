import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function isWithinSLA(
  receivedAt: string,
  slaDays: number,
  cutoffHour: number,
  cutoffTimezone: string,
  shippingDays: number[]
): boolean {
  const received = new Date(receivedAt);
  const receivedInTZ = new Date(received.toLocaleString("en-US", { timeZone: cutoffTimezone }));
  const receivedHour = receivedInTZ.getHours();

  const current = new Date(receivedInTZ);
  current.setHours(0, 0, 0, 0);

  if (receivedHour >= cutoffHour) {
    current.setDate(current.getDate() + 1);
  }

  const toISO = (jsDay: number) => jsDay === 0 ? 7 : jsDay;
  while (!shippingDays.includes(toISO(current.getDay()))) {
    current.setDate(current.getDate() + 1);
  }

  let counted = 0;
  while (counted < slaDays) {
    current.setDate(current.getDate() + 1);
    if (shippingDays.includes(toISO(current.getDay()))) {
      counted++;
    }
  }

  current.setHours(23, 59, 59, 999);
  const nowInTZ = new Date(new Date().toLocaleString("en-US", { timeZone: cutoffTimezone }));
  return nowInTZ <= current;
}

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
    const [syncRes, suspRes, transitRes, deliveredRes, refundedRes, awaitLateRes] = await Promise.all([
      // Sync errors
      base().is("amplifier_order_id", null)
        .is("sync_resolved_at", null)
        .not("fulfillment_status", "ilike", "fulfilled")
        .not("financial_status", "ilike", "refunded")
        .not("financial_status", "ilike", "partially_refunded")
        .lt("created_at", sixHoursAgo)
        .not("tags", "ilike", "%suspicious%"),
      // Suspicious
      base().ilike("tags", "%suspicious%")
        .not("fulfillment_status", "ilike", "fulfilled"),
      // In transit: fulfilled (or partial with tracking) but not delivered
      base().or("fulfillment_status.ilike.fulfilled,amplifier_shipped_at.not.is.null")
        .not("delivery_status", "ilike", "delivered"),
      // Delivered
      base().ilike("delivery_status", "delivered"),
      // Refunded
      base().or("financial_status.ilike.refunded,financial_status.ilike.partially_refunded"),
      // Awaiting + late tracking candidates (split by SLA in JS)
      admin.from("orders")
        .select("amplifier_received_at")
        .eq("workspace_id", workspaceId)
        .not("financial_status", "ilike", "pending")
        .not("amplifier_order_id", "is", null)
        .not("amplifier_received_at", "is", null)
        .is("amplifier_shipped_at", null)
        .not("fulfillment_status", "ilike", "fulfilled"),
    ]);

    // Split awaiting vs late by SLA calculation
    let awaitingTracking = 0, lateTracking = 0;
    for (const o of awaitLateRes.data || []) {
      if (isWithinSLA(o.amplifier_received_at, slaDays, cutoffHour, cutoffTimezone, shippingDays)) {
        awaitingTracking++;
      } else {
        lateTracking++;
      }
    }

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
      .is("amplifier_order_id", null)
      .is("sync_resolved_at", null)
      .not("fulfillment_status", "ilike", "fulfilled")
      .not("financial_status", "ilike", "refunded")
      .not("financial_status", "ilike", "partially_refunded")
      .lt("created_at", sixHoursAgo)
      .not("tags", "ilike", "%suspicious%");
  } else if (filter === "suspicious") {
    query = query
      .ilike("tags", "%suspicious%")
      .not("fulfillment_status", "ilike", "fulfilled");
  } else if (filter === "in_transit") {
    query = query
      .or("fulfillment_status.ilike.fulfilled,amplifier_shipped_at.not.is.null")
      .not("delivery_status", "ilike", "delivered");
  } else if (filter === "delivered") {
    query = query.ilike("delivery_status", "delivered");
  } else if (filter === "refunded") {
    query = query.or("financial_status.ilike.refunded,financial_status.ilike.partially_refunded");
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

  // For awaiting/late tracking, fetch all matching and post-filter
  if (filter === "awaiting_tracking" || filter === "late_tracking") {
    query = query
      .not("amplifier_order_id", "is", null)
      .not("amplifier_received_at", "is", null)
      .is("amplifier_shipped_at", null)
      .not("fulfillment_status", "ilike", "fulfilled");

    query = query.order(sortCol, { ascending: order === "asc" });

    const { data: allMatching, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const filtered = (allMatching || []).filter(o => {
      const within = isWithinSLA(o.amplifier_received_at, slaDays, cutoffHour, cutoffTimezone, shippingDays);
      return filter === "awaiting_tracking" ? within : !within;
    });

    const page = filtered.slice(offset, offset + limit);

    return NextResponse.json({
      orders: page,
      total: filtered.length,
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
