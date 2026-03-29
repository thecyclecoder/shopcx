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
  const { data: products } = await admin
    .from("products")
    .select("id, shopify_product_id, title, handle, product_type, status, image_url, variants")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("title");

  return NextResponse.json(products || []);
}
