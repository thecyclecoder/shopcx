import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; customerId: string }> },
) {
  const { id: workspaceId, customerId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("customer_demographics")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .maybeSingle();

  return NextResponse.json({ demographics: data || null });
}
