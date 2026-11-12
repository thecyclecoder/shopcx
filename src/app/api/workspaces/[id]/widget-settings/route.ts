import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeSupportLiveHours } from "@/lib/support-mode";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("widget_enabled, widget_color, widget_greeting, widget_position, chat_ticket_creation, support_live_hours")
    .eq("id", workspaceId)
    .single();

  return NextResponse.json(data || {});
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { widget_enabled, widget_color, widget_greeting, widget_position, chat_ticket_creation, support_live_hours } = body;

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {};
  if (widget_enabled !== undefined) updates.widget_enabled = widget_enabled;
  if (widget_color !== undefined) updates.widget_color = widget_color;
  if (widget_greeting !== undefined) updates.widget_greeting = widget_greeting;
  if (widget_position !== undefined) updates.widget_position = widget_position;
  if (chat_ticket_creation !== undefined) updates.chat_ticket_creation = chat_ticket_creation;
  // Live hours for the software-mode escalation handoff. null = never live (always the
  // email-reply promise). Normalized so a malformed value clears back to null rather than
  // persisting junk. See src/lib/support-mode.ts.
  if (support_live_hours !== undefined) {
    updates.support_live_hours = normalizeSupportLiveHours(support_live_hours);
  }

  const { error } = await admin
    .from("workspaces")
    .update(updates)
    .eq("id", workspaceId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
