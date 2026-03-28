import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
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

  // Check if Klaviyo is configured
  const { data: ws } = await admin
    .from("workspaces")
    .select("klaviyo_api_key_encrypted")
    .eq("id", workspaceId)
    .single();

  if (!ws?.klaviyo_api_key_encrypted) {
    return NextResponse.json({ error: "Klaviyo not configured" }, { status: 400 });
  }

  // Fire Inngest event for async sync
  await inngest.send({
    name: "klaviyo/sync-reviews",
    data: { workspace_id: workspaceId },
  });

  // Also do a quick count for immediate UI feedback
  const { count } = await admin
    .from("product_reviews")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);

  return NextResponse.json({
    synced: 0,
    errors: 0,
    total_reviews: count || 0,
    message: "Review sync started in background",
  });
}
