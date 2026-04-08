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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("widget_enabled, widget_color, widget_greeting, widget_position, chat_ticket_creation")
    .eq("id", workspaceId)
    .single();

  return NextResponse.json(data || {});
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { widget_enabled, widget_color, widget_greeting, widget_position, chat_ticket_creation } = body;

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {};
  if (widget_enabled !== undefined) updates.widget_enabled = widget_enabled;
  if (widget_color !== undefined) updates.widget_color = widget_color;
  if (widget_greeting !== undefined) updates.widget_greeting = widget_greeting;
  if (widget_position !== undefined) updates.widget_position = widget_position;
  if (chat_ticket_creation !== undefined) updates.chat_ticket_creation = chat_ticket_creation;

  const { error } = await admin
    .from("workspaces")
    .update(updates)
    .eq("id", workspaceId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
