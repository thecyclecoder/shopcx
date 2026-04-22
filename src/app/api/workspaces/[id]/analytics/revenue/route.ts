import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  const startDate = url.searchParams.get("start");
  const endDate = url.searchParams.get("end");
  const mode = url.searchParams.get("mode") || "daily"; // "daily" | "monthly"

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

  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (mode === "monthly") {
    // Read from pre-computed monthly snapshots (rebuilt nightly)
    const monthsBack = parseInt(url.searchParams.get("months") || "16");
    const now = new Date();
    const earliest = `${now.getFullYear()}-${String(now.getMonth() + 1 - monthsBack).padStart(2, "0")}`;
    // Build earliest month key properly
    const earliestDate = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
    const earliestMonth = earliestDate.toISOString().slice(0, 7);

    const { data: months } = await admin
      .from("monthly_revenue_snapshots")
      .select("*")
      .eq("workspace_id", workspaceId)
      .gte("month", earliestMonth)
      .order("month", { ascending: true });

    return NextResponse.json({ months: months || [] });
  }

  // Daily mode
  if (!startDate || !endDate) {
    return NextResponse.json({ error: "start and end date required" }, { status: 400 });
  }

  const { data: snapshots } = await admin
    .from("daily_order_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId)
    .gte("snapshot_date", startDate)
    .lte("snapshot_date", endDate)
    .order("snapshot_date", { ascending: true });

  return NextResponse.json({ snapshots: snapshots || [] });
}
