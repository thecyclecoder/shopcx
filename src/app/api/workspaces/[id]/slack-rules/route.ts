import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const admin = createAdminClient();

  const { data: rules } = await admin
    .from("slack_notification_rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("event_type");

  return NextResponse.json({ rules: rules || [] });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const { rules } = (await req.json()) as {
    rules: {
      event_type: string;
      channel_id: string | null;
      channel_name: string | null;
      dm_assigned_agent: boolean;
      dm_admins: boolean;
      enabled: boolean;
    }[];
  };

  const admin = createAdminClient();

  for (const rule of rules) {
    await admin.from("slack_notification_rules").upsert(
      {
        workspace_id: workspaceId,
        event_type: rule.event_type,
        channel_id: rule.channel_id,
        channel_name: rule.channel_name,
        dm_assigned_agent: rule.dm_assigned_agent,
        dm_admins: rule.dm_admins,
        enabled: rule.enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,event_type" },
    );
  }

  return NextResponse.json({ ok: true });
}
