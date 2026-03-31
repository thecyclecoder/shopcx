import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { getSlackToken, listChannels } from "@/lib/slack";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 400 });

  const token = await getSlackToken(workspaceId);
  if (!token) return NextResponse.json({ error: "Slack not connected" }, { status: 400 });

  const channels = await listChannels(token);
  return NextResponse.json({ channels });
}
