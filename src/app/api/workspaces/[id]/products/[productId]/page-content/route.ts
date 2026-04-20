import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: versions } = await admin
    .from("product_page_content")
    .select(
      "id, version, status, generated_at, approved_at, approved_by, published_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("version", { ascending: false });

  const latestId = versions?.[0]?.id;
  let latest = null;
  if (latestId) {
    const { data } = await admin
      .from("product_page_content")
      .select("*")
      .eq("id", latestId)
      .single();
    latest = data;
  }

  return NextResponse.json({
    latest,
    versions: versions || [],
  });
}
