import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: views } = await admin
    .from("ticket_views")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .order("sort_order", { ascending: true });

  // Compute ticket counts for each view (capped at 100 for performance)
  const enriched = await Promise.all((views || []).map(async (view) => {
    const filters = (view.filters || {}) as Record<string, string>;
    if (Object.keys(filters).length === 0) return { ...view, count: null };

    let query = admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);

    if (filters.status) query = query.eq("status", filters.status);
    if (filters.channel) query = query.eq("channel", filters.channel);
    if (filters.assigned_to) query = query.eq("assigned_to", filters.assigned_to);
    if (filters.tag) query = query.contains("tags", [filters.tag]);
    if (filters.search) query = query.ilike("subject", `%${filters.search}%`);

    // Exclude snoozed tickets (matches ticket list page behavior)
    query = query.or("snoozed_until.is.null,snoozed_until.lte." + new Date().toISOString());

    query = query.limit(100);
    const { count } = await query;
    return { ...view, count: count ?? 0 };
  }));

  return NextResponse.json(enriched);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();

  const { data: view, error } = await admin
    .from("ticket_views")
    .insert({
      workspace_id: workspaceId,
      user_id: user.id,
      name: body.name || "Untitled View",
      filters: body.filters || {},
      parent_id: body.parent_id || null,
      sort_order: body.sort_order ?? 0,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(view, { status: 201 });
}
