import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("chargeback_stats", { p_workspace_id: workspaceId });

  if (error) {
    console.error("Chargeback stats error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data?.[0] || {
    total_count: 0,
    under_review_count: 0,
    won_count: 0,
    lost_count: 0,
    total_amount_cents: 0,
    auto_cancelled_count: 0,
    evidence_due_soon: 0,
  });
}
