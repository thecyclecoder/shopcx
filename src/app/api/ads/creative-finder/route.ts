/**
 * Winning Static-Creative Finder — skeletons list + manual sweep trigger.
 *
 *   GET  ?workspaceId=&status=&kind=        → analyzed creative_skeletons (browse/shortlist)
 *   POST { workspaceId, productId?, force? } → fire the deliberate per-product scout
 *                                             (ads/creative-scout.sweep — all products, or one when
 *                                             productId is given), or mode:"video" → drain video_pending
 *                                             (ads/creative-finder.video, creative-finder-video)
 *
 * See docs/brain/specs/winning-static-creative-finder.md + creative-finder-video.md.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signCreativeShot } from "@/lib/creative-skeleton";
import { inngest } from "@/lib/inngest/client";

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

  const statusFilter = url.searchParams.get("status"); // e.g. analyzed | shortlisted | video_pending
  const kind = url.searchParams.get("kind"); // category | competitor

  let q = auth.admin
    .from("creative_skeletons")
    .select(
      "id, advertiser, title, image_url, thumb_path, media_type, format, framework, hook, mechanism_claim, proof, offer, days_running, heat, first_seen, last_seen, seed_keyword, seed_kind, status, created_at",
    )
    .eq("workspace_id", workspaceId as string)
    .order("days_running", { ascending: false, nullsFirst: false })
    .limit(500);

  if (statusFilter) q = q.eq("status", statusFilter);
  else q = q.in("status", ["analyzed", "shortlisted"]);
  if (kind) q = q.eq("seed_kind", kind);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Attach a signed URL to OUR stored downscaled copy so the dashboard serves it directly from storage
  // (no live AdLibrary proxy). Legacy rows without thumb_path get null → the client falls back to the proxy.
  const rows = data || [];
  const withThumbs = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      thumb_url: r.thumb_path ? await signCreativeShot(r.thumb_path as string) : null,
    })),
  );
  return NextResponse.json(withThumbs);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    workspaceId?: string;
    productId?: string;
    mode?: string;
    force?: boolean;
  };
  const workspaceId = body.workspaceId || null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  if (body.mode === "video") {
    // Drain this workspace's video_pending backlog through the Phase-1 video pipeline.
    await inngest.send({ name: "ads/creative-finder.video", data: { workspaceId } });
    return NextResponse.json({ ok: true, queued: true, mode: "video" });
  }

  // The deliberate per-product scout. force=true bypasses the freshness gate (explicit user action =
  // intentional spend); default respects it so re-clicking the button doesn't burn AdLibrary quota.
  // productId (optional) scopes to a single product — the per-product path that keeps us under the API cap.
  const force = body.force === true;
  await inngest.send({
    name: "ads/creative-scout.sweep",
    data: { workspaceId, productId: body.productId, force },
  });
  return NextResponse.json({ ok: true, queued: true, forced: force, productId: body.productId ?? null });
}
