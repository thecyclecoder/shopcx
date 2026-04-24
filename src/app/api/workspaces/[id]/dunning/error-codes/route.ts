import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: codes } = await admin
    .from("dunning_error_codes")
    .select("id, error_code, error_message, is_terminal, occurrence_count, first_seen_at, last_seen_at")
    .eq("workspace_id", workspaceId)
    .order("occurrence_count", { ascending: false });

  return NextResponse.json(codes || []);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
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

  const body = await request.json();

  // Expects { updates: [{ id: string, is_terminal: boolean }] }
  if (!Array.isArray(body.updates)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  for (const update of body.updates) {
    if (!update.id || typeof update.is_terminal !== "boolean") continue;
    await admin
      .from("dunning_error_codes")
      .update({ is_terminal: update.is_terminal })
      .eq("id", update.id)
      .eq("workspace_id", workspaceId);
  }

  // Return updated list
  const { data: codes } = await admin
    .from("dunning_error_codes")
    .select("id, error_code, error_message, is_terminal, occurrence_count, first_seen_at, last_seen_at")
    .eq("workspace_id", workspaceId)
    .order("occurrence_count", { ascending: false });

  return NextResponse.json(codes || []);
}
