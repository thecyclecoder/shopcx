import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string; contentId: string }> },
) {
  const { id: workspaceId, productId, contentId } = await params;
  void request;

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

  const { data: current } = await admin
    .from("product_page_content")
    .select("status")
    .eq("id", contentId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .single();

  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (current.status === "published") {
    return NextResponse.json({ error: "Already published" }, { status: 400 });
  }

  const { error } = await admin
    .from("product_page_content")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", contentId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
