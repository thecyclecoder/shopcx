import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const CHANNELS = ["email", "chat", "sms", "meta_dm", "phone"];

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

  const { data: configs } = await admin
    .from("ai_channel_config")
    .select("*, ai_personalities(name, tone)")
    .eq("workspace_id", workspaceId)
    .order("channel");

  // Ensure all channels have a config row
  const existing = new Set((configs || []).map((c) => c.channel));
  const result = [...(configs || [])];

  for (const ch of CHANNELS) {
    if (!existing.has(ch)) {
      result.push({
        id: null,
        workspace_id: workspaceId,
        channel: ch,
        personality_id: null,
        enabled: false,
        sandbox: true,
        instructions: "",
        max_response_length: null,
        confidence_threshold: 0.95,
        auto_resolve: false,
        ai_personalities: null,
        created_at: null,
        updated_at: null,
      });
    }
  }

  return NextResponse.json(result.sort((a, b) => a.channel.localeCompare(b.channel)));
}

export async function PUT(
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
  const { channel, personality_id, enabled, sandbox, instructions, max_response_length, confidence_threshold, auto_resolve } = body;

  if (!channel || !CHANNELS.includes(channel)) {
    return NextResponse.json({ error: "Valid channel required" }, { status: 400 });
  }

  const row = {
    workspace_id: workspaceId,
    channel,
    personality_id: personality_id || null,
    enabled: enabled ?? false,
    sandbox: sandbox ?? true,
    instructions: instructions || "",
    max_response_length: max_response_length || null,
    confidence_threshold: confidence_threshold ?? 0.95,
    auto_resolve: auto_resolve ?? false,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await admin
    .from("ai_channel_config")
    .upsert(row, { onConflict: "workspace_id,channel" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
