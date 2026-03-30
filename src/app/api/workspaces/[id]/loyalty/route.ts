import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const DEFAULT_TIERS = [
  { label: "$5 Off", points_cost: 500, discount_value: 5 },
  { label: "$10 Off", points_cost: 1000, discount_value: 10 },
  { label: "$15 Off", points_cost: 1500, discount_value: 15 },
];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
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
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: settings } = await admin
    .from("loyalty_settings")
    .select("*")
    .eq("workspace_id", workspaceId)
    .single();

  if (!settings) {
    return NextResponse.json({
      workspace_id: workspaceId,
      enabled: false,
      points_per_dollar: 10,
      points_per_dollar_value: 100,
      redemption_tiers: DEFAULT_TIERS,
      coupon_applies_to: "both",
      coupon_combines_product: true,
      coupon_combines_shipping: true,
      coupon_combines_order: false,
      coupon_expiry_days: 90,
      exclude_tax: true,
      exclude_discounts: true,
      exclude_shipping: true,
      exclude_shipping_protection: true,
    });
  }

  return NextResponse.json({
    ...settings,
    redemption_tiers: typeof settings.redemption_tiers === "string"
      ? JSON.parse(settings.redemption_tiers)
      : settings.redemption_tiers || DEFAULT_TIERS,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
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

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const allowed = [
    "enabled", "points_per_dollar", "points_per_dollar_value",
    "redemption_tiers", "coupon_applies_to",
    "coupon_combines_product", "coupon_combines_shipping", "coupon_combines_order",
    "coupon_expiry_days",
    "exclude_tax", "exclude_discounts", "exclude_shipping", "exclude_shipping_protection",
  ];

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  const { data, error } = await admin
    .from("loyalty_settings")
    .upsert({ workspace_id: workspaceId, ...updates }, { onConflict: "workspace_id" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ...data,
    redemption_tiers: typeof data.redemption_tiers === "string"
      ? JSON.parse(data.redemption_tiers)
      : data.redemption_tiers || DEFAULT_TIERS,
  });
}
