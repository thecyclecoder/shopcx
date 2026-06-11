import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAngleInputs } from "@/lib/ad-angles";
import { generateScript } from "@/lib/ad-script";
import { resolveAdToolSettings, getSceneStyle } from "@/lib/ad-tool-config";

async function authorize(workspaceId: string | null) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const { data, error } = await auth.admin
    .from("ad_campaigns")
    .select("*, products(title)")
    .eq("workspace_id", workspaceId as string)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Re-sign the hero thumbnail from its stable storage path so library cards
  // never show a broken image (the stored hero_image_url is a time-limited
  // signed URL that expires). Path is deterministic per campaign.
  const { signedUrl } = await import("@/lib/ad-storage");
  const rows = await Promise.all(
    (data || []).map(async (c) => {
      const fresh = await signedUrl(`avatars/${workspaceId}/heroes/${c.id}.png`).catch(() => null);
      return fresh ? { ...c, hero_image_url: fresh } : c;
    }),
  );
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const body = await req.json();
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const {
    name,
    productId,
    variantId,
    avatarId,
    angleId,
    lengthSec,
    vibeTags,
    captionStyle,
    voiceId,
    sceneStyle,
  } = body as {
    name?: string;
    productId?: string;
    variantId?: string;
    avatarId?: string;
    angleId?: string;
    lengthSec?: number;
    vibeTags?: string[];
    captionStyle?: string;
    voiceId?: string;
    sceneStyle?: string;
  };

  if (!productId || !angleId)
    return NextResponse.json({ error: "productId and angleId required" }, { status: 400 });

  // Load the chosen angle row.
  const { data: angleRow, error: angleErr } = await auth.admin
    .from("product_ad_angles")
    .select("*")
    .eq("id", angleId)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (angleErr || !angleRow)
    return NextResponse.json({ error: "angle_not_found" }, { status: 404 });

  const inputs = await loadAngleInputs(productId);

  // Workspace settings for banned words + caption default.
  const { data: ws } = await auth.admin
    .from("workspaces")
    .select("ad_tool_settings")
    .eq("id", workspaceId as string)
    .single();
  const settings = resolveAdToolSettings(ws?.ad_tool_settings);

  const len = (lengthSec === 15 ? 15 : 30) as 15 | 30;

  const result = await generateScript({
    angle: angleRow as any,
    inputs,
    lengthSec: len,
    bannedWords: settings.banned_words,
    workspaceId: workspaceId as string,
  });

  const vibe =
    Array.isArray(vibeTags) && vibeTags.length
      ? vibeTags
      : Array.isArray(angleRow.vibe_tags)
        ? angleRow.vibe_tags
        : [];

  const { data: campaign, error: insertErr } = await auth.admin
    .from("ad_campaigns")
    .insert({
      workspace_id: workspaceId as string,
      name: name || `${inputs.product_title} — ${angleRow.hook_slug}`,
      product_id: productId,
      avatar_id: avatarId || null,
      variant_id: variantId || null,
      angle_id: angleId,
      script_text: result.script,
      length_sec: len,
      voice_id: voiceId || null,
      caption_style: captionStyle || settings.default_caption_style,
      vibe_tags: vibe,
      scene_style: getSceneStyle(sceneStyle).value,
      status: "draft",
      created_by: auth.user.id,
    })
    .select("*")
    .single();

  if (insertErr || !campaign)
    return NextResponse.json(
      { error: insertErr?.message || "insert_failed" },
      { status: 500 },
    );

  return NextResponse.json({ campaign, script: result });
}
