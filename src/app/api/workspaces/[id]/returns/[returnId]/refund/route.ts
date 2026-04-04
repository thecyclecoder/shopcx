// POST: Issue refund or store credit for a return, then close

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processReturn, closeReturn } from "@/lib/shopify-returns";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; returnId: string }> }
) {
  const { id: workspaceId, returnId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { method } = body as { method?: "shopify_refund" | "store_credit" };

  const admin = createAdminClient();

  // Get return details
  const { data: returnRow, error: fetchError } = await admin
    .from("returns")
    .select("resolution_type, order_total_cents, label_cost_cents, shopify_return_gid")
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (fetchError || !returnRow) {
    return NextResponse.json({ error: "Return not found" }, { status: 404 });
  }

  const refundMethod = method || (returnRow.resolution_type.includes("refund") ? "shopify_refund" : "store_credit");

  try {
    if (refundMethod === "shopify_refund") {
      // Use processReturn for Shopify-native refund (dispose + refund + close in one call)
      const result = await processReturn(workspaceId, returnId);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
    } else {
      // Store credit: close the return in Shopify, credit is handled separately
      // (Store credit issuance will be done by the Inngest function or manually)
      const netRefund = returnRow.order_total_cents - returnRow.label_cost_cents;

      await admin
        .from("returns")
        .update({
          status: "refunded",
          net_refund_cents: netRefund,
          refunded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", returnId)
        .eq("workspace_id", workspaceId);

      // Close in Shopify
      const closeResult = await closeReturn(workspaceId, returnId);
      if (!closeResult.success) {
        console.error("Failed to close return in Shopify:", closeResult.error);
        // Don't fail the request — the refund/credit was recorded
      }
    }

    return NextResponse.json({ success: true, method: refundMethod });
  } catch (err) {
    console.error("Refund error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
