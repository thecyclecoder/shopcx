import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Get top 20 macros by usage_count (lifetime) + recent message usage
  const { data } = await admin
    .from("macros")
    .select("id, name, body_text, category, usage_count")
    .eq("workspace_id", workspaceId)
    .eq("active", true)
    .order("usage_count", { ascending: false })
    .limit(20);

  return NextResponse.json(data || []);
}
