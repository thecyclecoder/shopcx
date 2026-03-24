import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: return distinct order sources with counts + current mapping
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

  // Get distinct source_names with counts
  const { data: sources } = await admin
    .from("orders")
    .select("source_name")
    .eq("workspace_id", workspaceId)
    .not("source_name", "is", null);

  // Count by source
  const counts = new Map<string, number>();
  for (const row of sources || []) {
    const src = row.source_name || "unknown";
    counts.set(src, (counts.get(src) || 0) + 1);
  }

  // Get current mapping
  const { data: workspace } = await admin
    .from("workspaces")
    .select("order_source_mapping")
    .eq("id", workspaceId)
    .single();

  const mapping = (workspace?.order_source_mapping || {}) as Record<string, string>;

  const result = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => ({
      source,
      count,
      order_type: mapping[source] || "unknown",
    }));

  return NextResponse.json({ sources: result, mapping });
}

// PATCH: update the mapping + apply to existing orders
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const mapping = body.mapping as Record<string, string>;

  if (!mapping || typeof mapping !== "object") {
    return NextResponse.json({ error: "Invalid mapping" }, { status: 400 });
  }

  // Save mapping to workspace
  await admin
    .from("workspaces")
    .update({ order_source_mapping: mapping })
    .eq("id", workspaceId);

  // Apply mapping to all existing orders
  let updated = 0;
  for (const [source, orderType] of Object.entries(mapping)) {
    if (!["checkout", "recurring", "unknown"].includes(orderType)) continue;

    const { count } = await admin
      .from("orders")
      .update({ order_type: orderType })
      .eq("workspace_id", workspaceId)
      .eq("source_name", source);

    updated += count || 0;
  }

  return NextResponse.json({ success: true, updated });
}
