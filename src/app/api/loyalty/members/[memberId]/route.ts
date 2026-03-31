import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getLoyaltySettings,
  getRedemptionTiers,
  pointsToDollarValue,
} from "@/lib/loyalty";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ memberId: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { memberId } = await params;
  const admin = createAdminClient();

  // Get member
  const { data: member, error: memberError } = await admin
    .from("loyalty_members")
    .select("*, customers(id, first_name, last_name, email, shopify_customer_id)")
    .eq("id", memberId)
    .single();

  if (memberError || !member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  // Verify workspace membership
  const { data: wsm } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", member.workspace_id)
    .eq("user_id", user.id)
    .single();
  if (!wsm) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Get settings for dollar value + tiers
  const settings = await getLoyaltySettings(member.workspace_id);
  const tiers = getRedemptionTiers(settings).map((t, idx) => ({
    ...t,
    tier_index: idx,
    affordable: member.points_balance >= t.points_cost,
  }));

  // Transactions
  const { data: transactions } = await admin
    .from("loyalty_transactions")
    .select("*")
    .eq("member_id", memberId)
    .order("created_at", { ascending: false })
    .limit(100);

  // Redemptions
  const { data: redemptions } = await admin
    .from("loyalty_redemptions")
    .select("*")
    .eq("member_id", memberId)
    .order("created_at", { ascending: false })
    .limit(100);

  // Unused coupons (active or applied, not expired)
  const unusedCoupons = (redemptions || []).filter(
    (r: { status: string; expires_at: string | null }) =>
      (r.status === "active" || r.status === "applied") &&
      (!r.expires_at || new Date(r.expires_at) > new Date()),
  );

  // Discount history from orders (discount_codes field)
  let discountHistory: { code: string; order_number: string | null; total_cents: number; created_at: string }[] = [];
  if (member.customer_id) {
    const { data: orders } = await admin
      .from("orders")
      .select("order_number, total_cents, discount_codes, created_at")
      .eq("customer_id", member.customer_id)
      .not("discount_codes", "eq", "[]")
      .order("created_at", { ascending: false })
      .limit(50);

    if (orders) {
      for (const o of orders) {
        const codes = o.discount_codes as string[] | null;
        if (codes && codes.length > 0) {
          for (const code of codes) {
            discountHistory.push({
              code,
              order_number: o.order_number,
              total_cents: o.total_cents,
              created_at: o.created_at,
            });
          }
        }
      }
    }
  }

  return NextResponse.json({
    member,
    dollar_value: pointsToDollarValue(member.points_balance, settings),
    tiers,
    transactions: transactions || [],
    redemptions: redemptions || [],
    unused_coupons: unusedCoupons,
    discount_history: discountHistory,
    workspace_role: wsm.role,
  });
}

// Manual adjustment (admin only)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ memberId: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { memberId } = await params;
  const admin = createAdminClient();

  // Get member
  const { data: member } = await admin
    .from("loyalty_members")
    .select("*")
    .eq("id", memberId)
    .single();

  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // Verify admin/owner
  const { data: wsm } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", member.workspace_id)
    .eq("user_id", user.id)
    .single();
  if (!wsm || !["admin", "owner"].includes(wsm.role)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { points, reason } = body as { points?: number; reason?: string };

  if (!points || points === 0) {
    return NextResponse.json({ error: "Points amount required (positive or negative)" }, { status: 400 });
  }

  // Create transaction
  await admin.from("loyalty_transactions").insert({
    workspace_id: member.workspace_id,
    member_id: memberId,
    points_change: points,
    type: "adjustment",
    description: reason || `Manual adjustment: ${points > 0 ? "+" : ""}${points} points`,
  });

  // Update balance
  const newBalance = Math.max(0, member.points_balance + points);
  const updates: Record<string, unknown> = {
    points_balance: newBalance,
    updated_at: new Date().toISOString(),
  };
  if (points > 0) updates.points_earned = member.points_earned + points;

  await admin.from("loyalty_members").update(updates).eq("id", memberId);

  return NextResponse.json({ ok: true, new_balance: newBalance });
}
