import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveAdToolSettings, type AdToolSettings } from "@/lib/ad-tool-config";

async function authorize(workspaceId: string) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user, admin };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(id);
  if (auth.error) return auth.error;

  const { data: ws, error } = await auth.admin
    .from("workspaces")
    .select("ad_tool_settings")
    .eq("id", id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(resolveAdToolSettings(ws?.ad_tool_settings));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(id);
  if (auth.error) return auth.error;

  const body = (await req.json()) as Partial<AdToolSettings> & { workspaceId?: string };
  delete (body as Record<string, unknown>).workspaceId;

  const { data: ws } = await auth.admin
    .from("workspaces")
    .select("ad_tool_settings")
    .eq("id", id)
    .single();

  const current = resolveAdToolSettings(ws?.ad_tool_settings);
  const merged = resolveAdToolSettings({ ...current, ...body });

  const { error } = await auth.admin
    .from("workspaces")
    .update({ ad_tool_settings: merged })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(merged);
}
