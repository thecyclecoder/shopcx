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

  // Convert to cutoff timezone to determine the business day
  const receivedInTZ = new Date(received.toLocaleString("en-US", { timeZone: cutoffTimezone }));
  const receivedHour = receivedInTZ.getHours();

  // Determine start day: if received before cutoff, start counting from that day
  // Otherwise start from next shipping day
  let current = new Date(receivedInTZ);
  current.setHours(0, 0, 0, 0);

  if (receivedHour >= cutoffHour) {
    // Move to next day
    current.setDate(current.getDate() + 1);
  }

  // Skip to next shipping day if current isn't one
  // JS getDay(): 0=Sun, need to convert to ISO: 1=Mon...7=Sun
  const toISO = (jsDay: number) => jsDay === 0 ? 7 : jsDay;
  while (!shippingDays.includes(toISO(current.getDay()))) {
    current.setDate(current.getDate() + 1);
  }

  // Count forward slaDays shipping days
  let counted = 0;
  while (counted < slaDays) {
    current.setDate(current.getDate() + 1);
    if (shippingDays.includes(toISO(current.getDay()))) {
      counted++;
    }
  }

  // SLA deadline is end of that day
  current.setHours(23, 59, 59, 999);

  // Compare against now in the same timezone
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

  // Get SLA settings
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

  // Filters
  const filter = url.searchParams.get("filter") || "late_tracking";
  const search = url.searchParams.get("search");
  const sort = url.searchParams.get("sort") || "created_at";
  const order = url.searchParams.get("order") || "desc";
  const limit = parseInt(url.searchParams.get("limit") || "25");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  // For counts, we need to fetch a broader set
  const countsMode = url.searchParams.get("counts") === "true";

  if (countsMode) {
    // Fetch counts for all categories — get recent unfulfilled + all relevant orders
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    const { data: allOrders } = await admin
      .from("orders")
      .select("id, fulfillment_status, tags, amplifier_order_id, amplifier_received_at, amplifier_shipped_at, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(5000);

    const orders = allOrders || [];
    let syncErrors = 0, suspicious = 0, lateTracking = 0, awaitingTracking = 0, inTransit = 0, fulfilled = 0;

    for (const o of orders) {
      const tags: string[] = o.tags || [];
      const isSuspicious = tags.includes("suspicious");
      const isFulfilled = o.fulfillment_status === "fulfilled";

      if (isSuspicious) { suspicious++; continue; }
      if (isFulfilled) { fulfilled++; continue; }

      if (o.amplifier_shipped_at) {
        inTransit++;
      } else if (o.amplifier_order_id && o.amplifier_received_at) {
        if (isWithinSLA(o.amplifier_received_at, slaDays, cutoffHour, cutoffTimezone, shippingDays)) {
          awaitingTracking++;
        } else {
          lateTracking++;
        }
      } else if (!o.amplifier_order_id && !isFulfilled && o.created_at < sixHoursAgo) {
        syncErrors++;
      }
    }

    return NextResponse.json({
      counts: { sync_error: syncErrors, suspicious, late_tracking: lateTracking, awaiting_tracking: awaitingTracking, in_transit: inTransit, fulfilled },
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
      customers!inner(id, email, first_name, last_name)
    `, { count: "exact" })
    .eq("workspace_id", workspaceId);

  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  // Apply filters
  if (filter === "sync_error") {
    query = query
      .is("amplifier_order_id", null)
      .neq("fulfillment_status", "fulfilled")
      .lt("created_at", sixHoursAgo)
      .not("tags", "cs", "{suspicious}");
  } else if (filter === "suspicious") {
    query = query.contains("tags", ["suspicious"]);
  } else if (filter === "in_transit") {
    query = query
      .not("amplifier_shipped_at", "is", null)
      .neq("fulfillment_status", "fulfilled");
  } else if (filter === "fulfilled") {
    query = query.eq("fulfillment_status", "fulfilled");
  }
  // awaiting_tracking and late_tracking need post-processing for SLA calc

  // Search
  if (search) {
    // Search by order number or customer
    const { data: matchingCustomers } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .or(`email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`);

    const customerIds = (matchingCustomers || []).map(c => c.id);

    // Also match order_number
    const orderNumberSearch = search.toUpperCase();
    if (customerIds.length > 0) {
      query = query.or(`order_number.ilike.%${orderNumberSearch}%,customer_id.in.(${customerIds.join(",")})`);
    } else {
      query = query.ilike("order_number", `%${orderNumberSearch}%`);
    }
  }

  // Sorting
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
