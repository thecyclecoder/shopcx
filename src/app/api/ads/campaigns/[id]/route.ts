import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSceneStyle } from "@/lib/ad-tool-config";

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

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const { data: campaign, error } = await auth.admin
    .from("ad_campaigns")
    .select("*, products(title)")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (error || !campaign)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Re-sign the hero from its stable path (stored URL is a time-limited signed
  // URL that expires) so the detail page never shows a broken hero image.
  {
    const { signedUrl } = await import("@/lib/ad-storage");
    const fresh = await signedUrl(`avatars/${workspaceId}/heroes/${id}.png`).catch(() => null);
    if (fresh) (campaign as any).hero_image_url = fresh;
  }

  const { data: videoRows } = await auth.admin
    .from("ad_videos")
    .select("*")
    .eq("campaign_id", id)
    .eq("workspace_id", workspaceId as string)
    .order("created_at", { ascending: false });
  const { signedUrl: signFinal } = await import("@/lib/ad-storage");
  // Re-sign final URLs from the stored path so links never expire (the stored
  // final_mp4_url/static_jpg_url is itself a time-limited signed URL).
  const videos = await Promise.all(
    (videoRows || []).map(async (v) => {
      const sp = (v.meta as any)?.storage_path as string | undefined;
      if (!sp) return v;
      const fresh = await signFinal(sp).catch(() => null);
      if (!fresh) return v;
      return v.media_kind === "static" ? { ...v, static_jpg_url: fresh } : { ...v, final_mp4_url: fresh };
    }),
  );

  // Creative library: the active pieces that make up this ad, with signed
  // preview URLs so the operator can inspect (and refresh) each one.
  const { data: segs } = await auth.admin
    .from("ad_segments")
    .select("id, kind, seq, version, script_text, prompt, model, storage_path, trim_sec, status, error")
    .eq("campaign_id", id)
    .eq("is_active", true)
    .order("kind", { ascending: true })
    .order("seq", { ascending: true });
  const { signedUrl } = await import("@/lib/ad-storage");
  const segments = await Promise.all(
    (segs || []).map(async (s) => ({
      ...s,
      preview_url: s.storage_path ? await signedUrl(s.storage_path).catch(() => null) : null,
    })),
  );

  // Product-media stills for the b-roll "animate a photo" picker.
  const { data: media } = await auth.admin
    .from("product_media")
    .select("slot, alt_text, webp_1080_url, url, display_order")
    .eq("product_id", (campaign as any).product_id)
    .order("display_order", { ascending: true })
    .limit(30);
  const brollSources = (media || [])
    .filter((m) => m.slot !== "hero" && (m.webp_1080_url || m.url))
    .map((m) => ({ slot: m.slot, alt_text: m.alt_text, url: (m.webp_1080_url || m.url) as string }));

  // Widened for the read-only lifecycle preview — the full Meta target chain (account → campaign →
  // adset → ad) + the operator-selected page identity + the creative id that was uploaded.
  const { data: publishJobs } = await auth.admin
    .from("ad_publish_jobs")
    .select(
      "id, publish_status, meta_account_id, meta_campaign_id, meta_adset_id, meta_ad_id, meta_creative_id, meta_page_id, meta_instagram_user_id, video_id, cta_type, destination_url, publish_active, error, created_at",
    )
    .eq("campaign_id", id)
    .order("created_at", { ascending: false })
    .limit(10);

  // Temperature-banded copy pack (warm → cold → hot). Empty array when Dahlia authored a single
  // deterministic caption (pre-author-mode) — the UI falls back to the angle's copy_pack below.
  const { readCopyVariants } = await import("@/lib/ads/ad-copy-variants");
  const copyVariants = await readCopyVariants(auth.admin, id).catch(() => []);

  // The angle carries the canonical caption + the deterministic variation set (metadata.copy_pack:
  // { headlines[], primaryTexts[], description }). Read scoped by the campaign's angle_id (primary
  // key) — the fallback source of "headline + primary text variations" when copyVariants is empty.
  let angle:
    | {
        meta_headline: string | null;
        meta_primary_text: string | null;
        meta_description: string | null;
        copy_pack: { headlines?: string[]; primaryTexts?: string[]; description?: string; frameworks?: string[] } | null;
        provenance: import("@/lib/ads/creative-agent").AngleProvenance | null;
      }
    | null = null;
  const angleId = (campaign as any).angle_id as string | null;
  if (angleId) {
    const { data: angleRow } = await auth.admin
      .from("product_ad_angles")
      .select("meta_headline, meta_primary_text, meta_description, metadata")
      .eq("id", angleId)
      .eq("workspace_id", workspaceId as string)
      .maybeSingle();
    if (angleRow)
      angle = {
        meta_headline: (angleRow.meta_headline as string | null) ?? null,
        meta_primary_text: (angleRow.meta_primary_text as string | null) ?? null,
        meta_description: (angleRow.meta_description as string | null) ?? null,
        copy_pack: ((angleRow.metadata as any)?.copy_pack as any) ?? null,
        provenance: ((angleRow.metadata as any)?.provenance as any) ?? null,
      };
  }

  // Max's latest copy-QC verdict (hard gates + persuasion + scroll-stop + suggestion). Null until
  // Max has run — the UI shows an "awaiting Max" state.
  const { readLatestCopyQaVerdict } = await import("@/lib/ads/creative-qa");
  const copyQaVerdict = await readLatestCopyQaVerdict(auth.admin, {
    workspaceId: workspaceId as string,
    adCampaignId: id,
  }).catch(() => null);

  // "Posted by" identity — the FB page + linked IG handle chosen on the most recent publish job.
  // Read-only enrichment; null when nothing has been published yet.
  let pageIdentity: { page_id: string; page_name: string | null; instagram_id: string | null } | null = null;
  const latestPageId = (publishJobs || []).find((j) => j.meta_page_id)?.meta_page_id;
  if (latestPageId) {
    const { data: page } = await auth.admin
      .from("meta_pages")
      .select("meta_page_id, meta_page_name, meta_instagram_id")
      .eq("workspace_id", workspaceId as string)
      .eq("meta_page_id", latestPageId)
      .maybeSingle();
    if (page)
      pageIdentity = {
        page_id: page.meta_page_id as string,
        page_name: (page.meta_page_name as string | null) ?? null,
        instagram_id: (page.meta_instagram_id as string | null) ?? null,
      };
  }

  return NextResponse.json({
    campaign,
    videos: videos || [],
    segments,
    brollSources,
    publishJobs: publishJobs || [],
    copyVariants,
    angle,
    copyQaVerdict,
    pageIdentity,
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const update: Record<string, unknown> = {};
  if (typeof body.script_text === "string") update.script_text = body.script_text;
  if (typeof body.voice_id === "string") update.voice_id = body.voice_id;
  if (typeof body.caption_style === "string") update.caption_style = body.caption_style;
  if (typeof body.name === "string") update.name = body.name;
  if (typeof body.scene_style === "string") update.scene_style = getSceneStyle(body.scene_style).value;

  if (Object.keys(update).length === 0)
    return NextResponse.json({ error: "no_fields" }, { status: 400 });

  const { data: campaign, error } = await auth.admin
    .from("ad_campaigns")
    .update(update)
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .select("*")
    .single();

  if (error || !campaign)
    return NextResponse.json({ error: error?.message || "update_failed" }, { status: 500 });

  return NextResponse.json({ campaign });
}

// Delete a campaign. Child rows (ad_videos, ad_segments, creative library,
// publish jobs) cascade; advertorial_pages unlink via ON DELETE SET NULL (the
// generated lander survives, reachable by product+slug).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const { error } = await auth.admin
    .from("ad_campaigns")
    .delete()
    .eq("id", id)
    .eq("workspace_id", workspaceId as string);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
