import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  void request;
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: ticket } = await admin.from("tickets")
    .select("ai_draft, ai_suggested_macro_id, ai_suggested_macro_name")
    .eq("id", id).single();

  return NextResponse.json({
    ai_draft: ticket?.ai_draft || null,
    ai_suggested_macro_id: ticket?.ai_suggested_macro_id || null,
    ai_suggested_macro_name: ticket?.ai_suggested_macro_name || null,
  });
}
