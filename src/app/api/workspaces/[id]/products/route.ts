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

  const url = new URL(request.url);
  const status = url.searchParams.get("status"); // "active" | "draft" | "archived" | "all"

  const admin = createAdminClient();
  let query = admin
    .from("products")
    .select(
      "id, shopify_product_id, title, handle, product_type, vendor, status, tags, image_url, variants, intelligence_status, updated_at",
    )
    .eq("workspace_id", workspaceId)
    .order("title");

  if (!status) {
    query = query.eq("status", "active");
  } else if (status !== "all") {
    query = query.eq("status", status);
  }

  const { data: products } = await query;

  return NextResponse.json(products || []);
}
