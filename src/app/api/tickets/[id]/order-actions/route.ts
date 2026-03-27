import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { refundOrder, cancelOrder, updateShippingAddress } from "@/lib/shopify-order-actions";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Owner/admin only
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Only owner or admin can perform order actions" }, { status: 403 });
  }

  // Verify ticket exists in workspace
  const { data: ticket } = await admin
    .from("tickets")
    .select("id")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  const body = await request.json();
  const { action, order_id, order_number, ...options } = body;

  if (!action || !order_id) {
    return NextResponse.json({ error: "action and order_id required" }, { status: 400 });
  }

  const agentName = user.user_metadata?.full_name || user.user_metadata?.name || user.email || "Agent";
  const orderLabel = order_number ? `#${order_number}` : order_id;

  let result: { success: boolean; error?: string };
  let noteText: string;

  switch (action) {
    case "refund": {
      result = await refundOrder(workspaceId, order_id, {
        full: options.full,
        lineItems: options.line_items,
        reason: options.reason,
        notify: options.notify,
      });
      noteText = result.success
        ? `Order ${orderLabel} ${options.full ? "fully" : "partially"} refunded by ${agentName}`
        : `Refund failed for order ${orderLabel}: ${result.error}`;
      break;
    }
    case "cancel": {
      result = await cancelOrder(workspaceId, order_id, {
        reason: options.reason || "OTHER",
        refund: options.refund,
        restock: options.restock,
        notify: options.notify,
      });
      noteText = result.success
        ? `Order ${orderLabel} cancelled by ${agentName} (reason: ${options.reason || "OTHER"})`
        : `Cancel failed for order ${orderLabel}: ${result.error}`;
      break;
    }
    case "update_address": {
      const addr = options.address;
      if (!addr?.address1 || !addr?.city || !addr?.province || !addr?.zip || !addr?.country) {
        return NextResponse.json({ error: "Address fields required: address1, city, province, zip, country" }, { status: 400 });
      }
      result = await updateShippingAddress(workspaceId, order_id, addr);
      noteText = result.success
        ? `Shipping address updated on order ${orderLabel} by ${agentName}`
        : `Address update failed for order ${orderLabel}: ${result.error}`;
      break;
    }
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  // Log as internal note on the ticket
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    workspace_id: workspaceId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    author_id: user.id,
    body_text: noteText,
    body_html: `<p>${noteText}</p>`,
  });

  if (result.success) {
    return NextResponse.json({ success: true, note: noteText });
  } else {
    return NextResponse.json({ success: false, error: result.error, note: noteText }, { status: 422 });
  }
}
