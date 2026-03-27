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
    .select("name, widget_enabled, widget_color, widget_greeting, widget_position")
    .eq("id", workspaceId)
    .single();

  if (!ws || !ws.widget_enabled) {
    return NextResponse.json({ error: "Widget not available" }, { status: 404 });
  }

  return NextResponse.json({
    name: ws.name,
    color: ws.widget_color || "#4f46e5",
    greeting: ws.widget_greeting || "Hi! How can we help you today?",
    position: ws.widget_position || "bottom-right",
  });
}
