import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const admin = createAdminClient();

  const { data: ws } = await admin
    .from("workspaces")
    .select("name, widget_enabled, widget_color, widget_greeting, widget_position, chat_ticket_creation")
    .eq("id", workspaceId)
    .single();

  if (!ws || !ws.widget_enabled) {
    return NextResponse.json({ error: "Widget not available" }, { status: 404 });
  }

  return NextResponse.json({
    name: ws.name,
    // Warm near-black. Deliberately NOT a saturated hue: the bubble sits on top of
    // every merchant's page and must never read as one of their CTAs. Indigo
    // (#4f46e5) competed with buttons; a green default competed with them harder.
    color: ws.widget_color || "#33272B",
    greeting: ws.widget_greeting || "Hi! How can we help you today?",
    position: ws.widget_position || "bottom-right",
    chatEnabled: ws.chat_ticket_creation ?? true,
  });
}
