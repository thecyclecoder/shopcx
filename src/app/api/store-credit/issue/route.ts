import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { issueStoreCredit } from "@/lib/store-credit";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("id, role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { customerId, amount, reason, ticketId, subscriptionId } = body;

  if (!customerId || !amount || !reason) {
    return NextResponse.json({ error: "customerId, amount, and reason are required" }, { status: 400 });
  }
  if (amount <= 0 || amount > 500) {
    return NextResponse.json({ error: "Amount must be between $0.01 and $500.00" }, { status: 400 });
  }

  // Look up customer
  const { data: customer } = await admin
    .from("customers")
    .select("id, shopify_customer_id")
    .eq("id", customerId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!customer?.shopify_customer_id) {
    return NextResponse.json({ error: "Customer not found or missing Shopify ID" }, { status: 404 });
  }

  const displayName = member.display_name || user.user_metadata?.full_name || user.email || "Admin";

  const result = await issueStoreCredit({
    workspaceId,
    customerId: customer.id,
    shopifyCustomerId: customer.shopify_customer_id,
    amount,
    reason,
    issuedBy: member.id,
    issuedByName: displayName,
    ticketId,
    subscriptionId,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Failed to issue store credit" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, balance: result.balance });
}
