import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { publishProductContent } from "@/lib/product-intelligence/publish";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string; contentId: string }> },
) {
  const { id: workspaceId, productId, contentId } = await params;
  void request;

  const { user } = await getAuthedUser();
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

  // Shared publish core — the box seed pipeline (auto-publish) runs the same code.
  const result = await publishProductContent(admin, { workspace_id: workspaceId, product_id: productId, contentId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ success: true });
}
