import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Known Shopify source names and app IDs → friendly names
const KNOWN_SOURCES: Record<string, string> = {
  web: "Online Store",
  pos: "Shopify POS",
  shopify_draft_order: "Draft Order",
  iphone: "Shopify iOS",
  android: "Shopify Android",
  subscription_contract_checkout_one: "Subscription (Recurring)",
  // Known app IDs
  "580111": "Shopify Online Store",
  "1354745": "Shopify POS",
  "2329312": "Shopify Draft Orders",
  "3890849": "Facebook & Instagram",
  "5765187": "Google & YouTube",
  "6009345": "Shop App",
  "5765955": "Shopify Inbox",
  "1778060": "Recharge",
  "3921523": "Bold Subscriptions",
  "294517": "Walmart Marketplace",
  walmart: "Walmart Marketplace",
};

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
    .eq("workspace_id", workspaceId);

  // Count by source
  const counts = new Map<string, number>();
  for (const row of sources || []) {
    const src = row.source_name || "(unknown)";
    counts.set(src, (counts.get(src) || 0) + 1);
  }

  // Get current mapping + threshold
  const { data: workspace } = await admin
    .from("workspaces")
    .select("order_source_mapping, replacement_threshold_cents")
    .eq("id", workspaceId)
    .single();

  const mapping = (workspace?.order_source_mapping || {}) as Record<string, string>;
  const replacementThreshold = workspace?.replacement_threshold_cents ?? 0;

  const result = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => ({
      source,
      friendly_name: KNOWN_SOURCES[source] || null,
      count,
      order_type: mapping[source] || "unknown",
    }));

  return NextResponse.json({ sources: result, mapping, replacement_threshold_cents: replacementThreshold });
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
  const replacementThreshold = body.replacement_threshold_cents as number | undefined;

  if (!mapping || typeof mapping !== "object") {
    return NextResponse.json({ error: "Invalid mapping" }, { status: 400 });
  }

  // Save mapping + threshold to workspace
  const wsUpdate: Record<string, unknown> = { order_source_mapping: mapping };
  if (replacementThreshold !== undefined) {
    wsUpdate.replacement_threshold_cents = Math.max(0, replacementThreshold);
  }
  await admin.from("workspaces").update(wsUpdate).eq("id", workspaceId);

  // Get threshold for replacement logic
  const { data: ws } = await admin
    .from("workspaces")
    .select("replacement_threshold_cents")
    .eq("id", workspaceId)
    .single();
  const threshold = ws?.replacement_threshold_cents ?? 0;

  // Apply mapping to all existing orders
  let updated = 0;
  for (const [source, orderType] of Object.entries(mapping)) {
    if (!["checkout", "recurring", "replacement", "unknown"].includes(orderType)) continue;

    if (orderType === "replacement") {
      // Replacement: only tag orders at or below the threshold
      const { count: replCount } = await admin
        .from("orders")
        .update({ order_type: "replacement" })
        .eq("workspace_id", workspaceId)
        .eq("source_name", source)
        .lte("total_cents", threshold);
      updated += replCount || 0;

      // Orders above threshold from this source get tagged as "checkout"
      const { count: nonReplCount } = await admin
        .from("orders")
        .update({ order_type: "checkout" })
        .eq("workspace_id", workspaceId)
        .eq("source_name", source)
        .gt("total_cents", threshold);
      updated += nonReplCount || 0;
    } else {
      const { count } = await admin
        .from("orders")
        .update({ order_type: orderType })
        .eq("workspace_id", workspaceId)
        .eq("source_name", source);
      updated += count || 0;
    }
  }

  return NextResponse.json({ success: true, updated });
}
