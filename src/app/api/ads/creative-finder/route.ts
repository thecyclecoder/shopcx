/**
 * Winning Static-Creative Finder — skeletons list + manual sweep trigger.
 *
 *   GET  ?workspaceId=&status=&kind=&includeHidden=  → analyzed creative_skeletons (browse/shortlist).
 *        LIST branch hides `do_not_use=true` rows by default (the CEO/Max-flagged bad
 *        imitation bases) and reports the suppressed count on an `X-Hidden-Count` response
 *        header; pass `includeHidden=1` to bring them back for the Show-hidden toggle.
 *        The `skeletonId=` detail branch is unaffected — a flagged ad still resolves so its
 *        detail page's Use-again toggle and Max's review-card links keep working.
 *   POST { workspaceId, productId?, force? } → fire the deliberate per-product scout
 *                                             (ads/creative-scout.sweep — all products, or one when
 *                                             productId is given), or mode:"video" → drain video_pending
 *                                             (ads/creative-finder.video, creative-finder-video)
 *
 * See docs/brain/specs/winning-static-creative-finder.md + creative-finder-video.md.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signCreativeShot } from "@/lib/creative-skeleton";
import { inngest } from "@/lib/inngest/client";

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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const statusFilter = url.searchParams.get("status"); // e.g. analyzed | shortlisted | video_pending
  const kind = url.searchParams.get("kind"); // category | competitor
  const productId = url.searchParams.get("productId"); // filter to one advertised product's ads
  const mediaType = url.searchParams.get("mediaType"); // 'static' | 'video' — the Research › Ads toggle
  const skeletonId = url.searchParams.get("skeletonId"); // single-ad fetch for the Research › Ads detail page
  // Show-hidden opt-in: the LIST branch hides do_not_use=true rows by default so the CEO's own
  // rejections (+ Max's auto-flags) do not clutter the imitation-base picker; `?includeHidden=1`
  // brings them back for the grid's Show-hidden toggle.
  const includeHidden =
    url.searchParams.get("includeHidden") === "1" ||
    url.searchParams.get("includeHidden") === "true";

  const SELECT =
    "id, advertiser, title, image_url, thumb_path, media_type, format, framework, hook, mechanism_claim, proof, offer, days_running, heat, first_seen, last_seen, seed_keyword, seed_kind, status, product_id, competitor_id, created_at, do_not_use, do_not_use_reason, do_not_use_by, do_not_use_at";

  // Detail page — one ad by id, regardless of status/media_type (the owner clicked into it from the grid).
  if (skeletonId) {
    const { data: one, error: oneErr } = await auth.admin
      .from("creative_skeletons")
      .select(SELECT)
      .eq("workspace_id", workspaceId as string)
      .eq("id", skeletonId)
      .maybeSingle();
    if (oneErr) return NextResponse.json({ error: oneErr.message }, { status: 500 });
    if (!one) return NextResponse.json({ error: "not found" }, { status: 404 });
    const r = one as Record<string, unknown>;
    return NextResponse.json({
      ...r,
      thumb_url: r.thumb_path ? await signCreativeShot(r.thumb_path as string) : null,
    });
  }

  // Shared narrowing predicates for the LIST query and the hidden-count query. Factored so the
  // "N hidden" number cannot drift from the rows the list actually returns — a mismatched
  // predicate would report a fictitious count. Only the `do_not_use` filter differs between the
  // two callers, so it is applied by the caller, not here.
  // A video toggle wants VIDEO ads regardless of their processing stage (video_pending OR later
  // flipped to analyzed), so when a mediaType is requested we widen the default status set to
  // include video_pending; otherwise keep the processed-only default (analyzed/shortlisted).
  type Narrowable<Q> = {
    eq: (col: string, val: unknown) => Q;
    in: (col: string, val: readonly string[]) => Q;
  };
  const applyNarrowing = <Q extends Narrowable<Q>>(q: Q): Q => {
    let out = q.eq("workspace_id", workspaceId as string);
    if (statusFilter) out = out.eq("status", statusFilter);
    else if (mediaType === "video") out = out.in("status", ["analyzed", "shortlisted", "video_pending"]);
    else out = out.in("status", ["analyzed", "shortlisted"]);
    if (kind) out = out.eq("seed_kind", kind);
    if (productId) out = out.eq("product_id", productId);
    if (mediaType === "static" || mediaType === "video") out = out.eq("media_type", mediaType);
    return out;
  };

  let q = auth.admin
    .from("creative_skeletons")
    .select(SELECT)
    .order("days_running", { ascending: false, nullsFirst: false })
    .limit(500);
  q = applyNarrowing(q);
  if (!includeHidden) q = q.eq("do_not_use", false);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // How many rows the default filter suppressed — same narrowing predicates, `do_not_use=true`
  // instead. Skip the count entirely when the caller opted in (nothing hidden in that mode).
  let hiddenCount = 0;
  if (!includeHidden) {
    let cq = auth.admin
      .from("creative_skeletons")
      .select("id", { count: "exact", head: true });
    cq = applyNarrowing(cq);
    cq = cq.eq("do_not_use", true);
    const { count } = await cq;
    hiddenCount = count ?? 0;
  }

  // Attach a signed URL to OUR stored downscaled copy so the dashboard serves it directly from storage
  // (no live AdLibrary proxy). Legacy rows without thumb_path get null → the client falls back to the proxy.
  const rows = data || [];
  const withThumbs = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      thumb_url: r.thumb_path ? await signCreativeShot(r.thumb_path as string) : null,
    })),
  );
  return NextResponse.json(withThumbs, {
    headers: { "X-Hidden-Count": String(hiddenCount) },
  });
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
