import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const memberId = url.searchParams.get("member_id");
  if (!memberId) return NextResponse.json({ error: "member_id required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: redemptions } = await admin.from("loyalty_redemptions")
    .select("id, discount_code, discount_value, points_spent, status, used_at, expires_at, created_at")
    .eq("member_id", memberId)
    .order("created_at", { ascending: false })
    .limit(10);

  return NextResponse.json({ redemptions: redemptions || [] });
}
