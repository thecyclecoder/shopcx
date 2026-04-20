import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

/**
 * POST: Trigger targeted gap research — looks for studies linking product
 * ingredients to a specific customer-reported benefit.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { theme_name, customer_benefit_names } = body as {
    theme_name: string;
    customer_benefit_names: string[];
  };

  if (!theme_name) {
    return NextResponse.json({ error: "theme_name is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify admin/owner
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await inngest.send({
    name: "intelligence/research-benefit-gap",
    data: {
      workspace_id: workspaceId,
      product_id: productId,
      theme_name,
      customer_benefit_names: customer_benefit_names || [theme_name],
    },
  });

  return NextResponse.json({ success: true });
}
