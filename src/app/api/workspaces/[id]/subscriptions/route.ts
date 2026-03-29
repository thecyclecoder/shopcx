import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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

  // Filters
  const status = url.searchParams.get("status"); // active, paused, cancelled, expired
  const recovery = url.searchParams.get("recovery"); // in_recovery, recovered, failed
  const payment = url.searchParams.get("payment"); // succeeded, failed, skipped
  const search = url.searchParams.get("search");
  const sort = url.searchParams.get("sort") || "next_billing_date";
  const order = url.searchParams.get("order") || "asc";
  const limit = parseInt(url.searchParams.get("limit") || "25");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  let query = admin
    .from("subscriptions")
    .select(`
      id, shopify_contract_id, shopify_customer_id, status,
      items, billing_interval, billing_interval_count,
      next_billing_date, last_payment_status, delivery_price_cents,
      created_at, updated_at, customer_id,
      customers!inner(id, email, first_name, last_name)
    `, { count: "exact" })
    .eq("workspace_id", workspaceId);

  // Status filter
  if (status && status !== "all") {
    query = query.eq("status", status);
  }

  // Payment filter
  if (payment && payment !== "all") {
    query = query.eq("last_payment_status", payment);
  }

  // Search
  if (search) {
    query = query.or(
      `customers.email.ilike.%${search}%,customers.first_name.ilike.%${search}%,customers.last_name.ilike.%${search}%`
    );
  }

  // Sorting
  const validSorts: Record<string, string> = {
    next_billing_date: "next_billing_date",
    created_at: "created_at",
    status: "status",
  };
  const sortCol = validSorts[sort] || "next_billing_date";
  query = query.order(sortCol, { ascending: order === "asc" });

  // Pagination
  query = query.range(offset, offset + limit - 1);

  const { data: subscriptions, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // If recovery filter is set, we need to join dunning_cycles
  let result = subscriptions || [];

  // Load dunning status for all returned subscriptions
  const contractIds = result.map(s => s.shopify_contract_id).filter(Boolean);
  let dunningMap: Record<string, { status: string; recovered_at: string | null }> = {};

  if (contractIds.length > 0) {
    const { data: cycles } = await admin
      .from("dunning_cycles")
      .select("shopify_contract_id, status, recovered_at")
      .eq("workspace_id", workspaceId)
      .in("shopify_contract_id", contractIds)
      .order("cycle_number", { ascending: false });

    // Keep latest cycle per contract
    for (const c of cycles || []) {
      if (!dunningMap[c.shopify_contract_id]) {
        dunningMap[c.shopify_contract_id] = { status: c.status, recovered_at: c.recovered_at };
      }
    }
  }

  // Annotate with recovery status
  const annotated = result.map(sub => {
    const dunning = dunningMap[sub.shopify_contract_id];
    let recovery_status: string | null = null;

    if (dunning) {
      if (dunning.status === "active" || dunning.status === "skipped") {
        recovery_status = "in_recovery";
      } else if (dunning.status === "paused" || dunning.status === "exhausted") {
        recovery_status = "failed";
      } else if (dunning.status === "recovered") {
        // Show "recovered" for 7 days
        const recoveredAt = dunning.recovered_at ? new Date(dunning.recovered_at) : null;
        if (recoveredAt && (Date.now() - recoveredAt.getTime()) < 7 * 24 * 60 * 60 * 1000) {
          recovery_status = "recovered";
        }
      }
    }

    // Calculate MRR (monthly recurring revenue)
    const items = (sub.items as { price_cents?: number; quantity?: number }[] | null) || [];
    const totalCents = items.reduce((sum, i) => sum + ((i.price_cents || 0) * (i.quantity || 1)), 0);
    const interval = sub.billing_interval || "month";
    const intervalCount = sub.billing_interval_count || 1;
    let mrr_cents = totalCents;
    if (interval === "year") mrr_cents = Math.round(totalCents / (12 * intervalCount));
    else if (interval === "week") mrr_cents = Math.round(totalCents * (4.33 / intervalCount));
    else if (interval === "day") mrr_cents = Math.round(totalCents * (30 / intervalCount));
    else mrr_cents = Math.round(totalCents / intervalCount);

    return { ...sub, recovery_status, mrr_cents };
  });

  // Apply recovery filter client-side (dunning status comes from separate table)
  let filtered = annotated;
  if (recovery === "in_recovery") filtered = annotated.filter(s => s.recovery_status === "in_recovery");
  else if (recovery === "recovered") filtered = annotated.filter(s => s.recovery_status === "recovered");
  else if (recovery === "failed") filtered = annotated.filter(s => s.recovery_status === "failed");

  return NextResponse.json({
    subscriptions: filtered,
    total: recovery && recovery !== "all" ? filtered.length : (count || 0),
  });
}
