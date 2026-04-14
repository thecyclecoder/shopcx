import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: List fraud cases with filters
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const ruleType = url.searchParams.get("rule_type");
  const severity = url.searchParams.get("severity");
  const limit = parseInt(url.searchParams.get("limit") || "25");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Check admin/owner role
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let query = admin
    .from("fraud_cases")
    .select("*, fraud_rules(name)", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const customerId = new URL(request.url).searchParams.get("customer_id");
  if (customerId) query = query.contains("customer_ids", [customerId]);
  if (status) query = query.eq("status", status);
  if (ruleType) query = query.eq("rule_type", ruleType);
  if (severity) query = query.eq("severity", severity);

  const { data: cases, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Compute stats
  const { data: stats } = await admin.rpc("fraud_case_stats", {
    p_workspace_id: workspaceId,
  });

  return NextResponse.json({
    cases: cases || [],
    total: count || 0,
    stats: stats?.[0] || { open_count: 0, confirmed_30d: 0, dismissed_30d: 0, value_at_risk_cents: 0 },
  });
}
