import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspace_id");
  if (!workspaceId) return NextResponse.json({ error: "workspace_id required" }, { status: 400 });

  const admin = createAdminClient();

  // Verify membership
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const search = searchParams.get("search") || "";
  const sort = searchParams.get("sort") || "points_balance";
  const order = searchParams.get("order") || "desc";
  const limit = Math.min(parseInt(searchParams.get("limit") || "25", 10), 250);
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  const customerId = searchParams.get("customer_id");

  let query = admin
    .from("loyalty_members")
    .select("*, customers(first_name, last_name, email)", { count: "exact" })
    .eq("workspace_id", workspaceId);

  if (customerId) {
    // Loyalty record may live on any of the linked customer profiles —
    // expand customer_id to the full link group so the ticket / customer
    // detail UIs surface the record regardless of which sibling profile
    // they're viewing.
    const linkedIds = new Set<string>([customerId]);
    const { data: link } = await admin
      .from("customer_links").select("group_id")
      .eq("workspace_id", workspaceId).eq("customer_id", customerId).maybeSingle();
    if (link?.group_id) {
      const { data: peers } = await admin
        .from("customer_links").select("customer_id")
        .eq("workspace_id", workspaceId).eq("group_id", link.group_id);
      for (const p of peers || []) if (p.customer_id) linkedIds.add(p.customer_id);
    }
    query = query.in("customer_id", [...linkedIds]);
  }

  if (search) {
    query = query.or(`email.ilike.%${search}%`);
  }

  const allowedSorts = ["points_balance", "points_earned", "points_spent", "updated_at", "created_at"];
  const sortCol = allowedSorts.includes(sort) ? sort : "points_balance";
  query = query.order(sortCol, { ascending: order === "asc" }).range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ members: data || [], total: count || 0 });
}
