import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAngleInputs } from "@/lib/ad-angles";
import { validateAdScript } from "@/lib/ad-validator";
import { resolveAdToolSettings } from "@/lib/ad-tool-config";

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId)
    return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
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

export async function POST(req: Request) {
  const body = await req.json();
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const { productId, angleId, script } = body as {
    productId?: string;
    angleId?: string;
    script?: string;
  };
  if (!productId || typeof script !== "string")
    return NextResponse.json({ error: "productId and script required" }, { status: 400 });

  const inputs = await loadAngleInputs(productId);

  let angle = null;
  if (angleId) {
    const { data } = await auth.admin
      .from("product_ad_angles")
      .select("*")
      .eq("id", angleId)
      .eq("workspace_id", workspaceId as string)
      .single();
    angle = data;
  }

  const { data: ws } = await auth.admin
    .from("workspaces")
    .select("ad_tool_settings")
    .eq("id", workspaceId as string)
    .single();
  const settings = resolveAdToolSettings(ws?.ad_tool_settings);

  const result = validateAdScript(script, (angle as any) || null, inputs, {
    bannedWords: settings.banned_words,
  });

  return NextResponse.json(result);
}
