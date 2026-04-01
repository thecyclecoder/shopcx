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

    const { data: allOrders } = await admin
      .from("orders")
      .select("id, fulfillment_status, financial_status, tags, amplifier_order_id, amplifier_received_at, amplifier_shipped_at, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(5000);

    const orders = allOrders || [];
    let syncErrors = 0, suspicious = 0, lateTracking = 0, awaitingTracking = 0, inTransit = 0, fulfilled = 0, refunded = 0;

    for (const o of orders) {
      const tagStr = (o.tags as string) || "";
      const isSuspicious = tagStr.includes("suspicious");
      const isFulfilled = o.fulfillment_status === "fulfilled";
      const isRefunded = o.financial_status === "refunded" || o.financial_status === "partially_refunded";

      // Refunded is its own count (can overlap with fulfilled)
      if (isRefunded) refunded++;

      // Primary category — fulfilled orders go to fulfilled, nothing else
      if (isFulfilled) { fulfilled++; continue; }
      if (isSuspicious) { suspicious++; continue; }

      if (o.amplifier_shipped_at) {
        inTransit++;
      } else if (o.amplifier_order_id && o.amplifier_received_at) {
        if (isWithinSLA(o.amplifier_received_at, slaDays, cutoffHour, cutoffTimezone, shippingDays)) {
          awaitingTracking++;
        } else {
          lateTracking++;
        }
      } else if (!o.amplifier_order_id && o.created_at < sixHoursAgo) {
        syncErrors++;
      }
    }

    return NextResponse.json({
      counts: { sync_error: syncErrors, suspicious, late_tracking: lateTracking, awaiting_tracking: awaitingTracking, in_transit: inTransit, fulfilled, refunded },
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
      customer_id, shopify_order_id,
      customers(id, email, first_name, last_name)
    `, { count: "exact" })
    .eq("workspace_id", workspaceId);

  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  // Apply filters
  if (filter === "sync_error") {
    query = query
      .is("amplifier_order_id", null)
      .neq("fulfillment_status", "fulfilled")
      .lt("created_at", sixHoursAgo)
      .not("tags", "ilike", "%suspicious%");
  } else if (filter === "suspicious") {
    query = query.ilike("tags", "%suspicious%");
  } else if (filter === "in_transit") {
    query = query
      .not("amplifier_shipped_at", "is", null)
      .neq("fulfillment_status", "fulfilled");
  } else if (filter === "fulfilled") {
    query = query.eq("fulfillment_status", "fulfilled");
  } else if (filter === "refunded") {
    query = query.in("financial_status", ["refunded", "partially_refunded"]);
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
      .neq("fulfillment_status", "fulfilled");

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
