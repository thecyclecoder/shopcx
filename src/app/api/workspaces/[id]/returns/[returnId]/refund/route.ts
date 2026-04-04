import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processReturn, closeReturn } from "@/lib/shopify-returns";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; returnId: string }> },
) {
  const { id: workspaceId, returnId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { method } = body as { method: "shopify_refund" | "store_credit" };

  if (!method) {
    return NextResponse.json({ error: "method is required (shopify_refund or store_credit)" }, { status: 400 });
  }

  const admin = createAdminClient();

  if (method === "shopify_refund") {
    // Use processReturn — handles dispose + refund + close in one call
    const result = await processReturn(workspaceId, returnId);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true, method: "shopify_refund" });
  }

  // Store credit — close the return without Shopify refund (credit handled by our system)
  const { data: ret } = await admin
    .from("returns")
    .select("net_refund_cents")
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret) {
    return NextResponse.json({ error: "Return not found" }, { status: 404 });
  }

  const closeResult = await closeReturn(workspaceId, returnId);
  if (!closeResult.success) {
    return NextResponse.json({ error: closeResult.error }, { status: 400 });
  }

  // Mark as refunded with store credit
  await admin
    .from("returns")
    .update({
      status: "refunded",
      refunded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", returnId);

  return NextResponse.json({ success: true, method: "store_credit" });
}
