import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { META_CTA_TYPES } from "@/lib/ad-meta-copy";
import { advertorialLanderUrl, appendScentMatchParams, hasScentMatchParams } from "@/lib/advertorial-pages";
import {
  MEDIA_BUYER_TEST_ORIGIN,
  evaluateMediaBuyerTestPublish,
  escalateMediaBuyerTestPublishRefusal,
  type MediaBuyerTestRefusalReason,
} from "@/lib/media-buyer/publish-gate";
import { getMetaUserToken, updateObjectBudget } from "@/lib/meta-ads";

async function authorize(workspaceId: string | null) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
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

const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/** Publish a campaign's video as a Meta ad — creates a job + fires the publisher. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  // Validate the campaign + the chosen video belong to the workspace.
  const { data: campaign } = await auth.admin
    .from("ad_campaigns")
    .select("id, name, landing_url")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const videoId = typeof body.video_id === "string" ? body.video_id : null;
  // Auto-select the latest ready media (video OR static) when no explicit id is
  // passed. Statics publish as image creatives (adToolPublishToMeta branches on
  // media_kind); the operator can pass a specific video_id to pick an archetype.
  const { data: video } = await auth.admin
    .from("ad_videos")
    .select("id, final_mp4_url, static_jpg_url, media_kind, status")
    .eq("campaign_id", id)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const useVideoId = videoId || video?.id || null;
  if (!useVideoId) return NextResponse.json({ error: "no_ready_media" }, { status: 400 });

  const headlines = arr(body.headlines), primaryTexts = arr(body.primary_texts);
  const ctaType = META_CTA_TYPES.includes(body.cta_type) ? body.cta_type : "SHOP_NOW";
  // Destination defaults to the campaign angle's advertorial lander (scent-match by
  // construction); an explicit destination_url from the operator still wins.
  // Prefer the campaign's seeded landing_url (archetype-routed: PDP for testimonial/
  // authority/big-claim, the matching lander for advertorial/before-after), then the
  // advertorial-lander fallback. An explicit operator destination_url still wins.
  let destinationUrl = typeof body.destination_url === "string" ? body.destination_url.trim() : "";
  if (!destinationUrl) destinationUrl = ((campaign as { landing_url?: string | null }).landing_url || "").trim();
  if (!destinationUrl) destinationUrl = (await advertorialLanderUrl(workspaceId as string, id)) || "";

  // Scent-match invariant (attribution-sensor-recalibration Phase 2): every
  // published ad's final destination must carry ?angle=&variant= so the
  // attribution sensor can resolve click → lander → variant. When the operator
  // (or the seeded campaign.landing_url) supplied a bare URL, derive the
  // missing params from advertorialLanderUrl() and append rather than silently
  // publishing an untrackable PDP.
  if (destinationUrl && !hasScentMatchParams(destinationUrl)) {
    const lander = await advertorialLanderUrl(workspaceId as string, id);
    if (lander) destinationUrl = appendScentMatchParams(destinationUrl, lander);
  }
  const required: Record<string, unknown> = { meta_account_id: body.meta_account_id, meta_adset_id: body.meta_adset_id, meta_page_id: body.meta_page_id };
  for (const [k, v] of Object.entries(required)) if (!v) return NextResponse.json({ error: `${k} required` }, { status: 400 });
  if (!headlines.length || !primaryTexts.length) return NextResponse.json({ error: "headlines + primary_texts required" }, { status: 400 });
  if (!destinationUrl) return NextResponse.json({ error: "destination_url required" }, { status: 400 });

  // Media-Buyer test-cohort gate (media-buyer-test-winner-loop Phase 1).
  // origin='media-buyer-test' opts into the autonomous go-live rail — the ad may
  // publish ACTIVE ONLY when the chosen ad set == the workspace's configured test
  // ad set AND the projected daily spend stays within the daily test ceiling.
  // Any refusal → publish PAUSED + escalate to the CEO (north star: hit a rail =
  // escalate, not execute). Non-media-buyer origins skip this entirely.
  const origin = typeof body.origin === "string" ? body.origin.trim() : null;
  const requestedActive = body.publish_active === true;
  let publishActive = requestedActive;
  let gateRefusal: {
    reason: MediaBuyerTestRefusalReason;
    diagnosis: string;
    ceilingCents: number | null;
    projectedDailyCents: number;
  } | null = null;
  let ceilingToApplyCents: number | null = null;

  if (origin === MEDIA_BUYER_TEST_ORIGIN && requestedActive) {
    // The projected daily spend the caller is asking the ad set to run at. The
    // Media Buyer supplies it explicitly; otherwise fall back to the cohort's
    // ceiling (the natural "run it to the cap" default the gate then confirms).
    const projected = Number.isFinite(Number(body.projected_daily_cents))
      ? Math.round(Number(body.projected_daily_cents))
      : null;
    const metaAdAccountRowId = typeof body.meta_ad_account_row_id === "string" ? body.meta_ad_account_row_id : null;
    // Evaluate with the projected value the caller supplied (or 0 as sentinel
    // "let the ceiling stand"; the gate treats 0 as under any positive ceiling).
    const verdict = await evaluateMediaBuyerTestPublish(auth.admin, {
      workspaceId: workspaceId as string,
      metaAdAccountId: metaAdAccountRowId,
      metaAdsetId: String(body.meta_adset_id),
      projectedDailyCents: projected ?? 0,
    });
    if (!verdict.allowed) {
      publishActive = false;
      gateRefusal = {
        reason: verdict.reason,
        diagnosis: verdict.diagnosis,
        ceilingCents: verdict.ceilingCents,
        projectedDailyCents: verdict.projectedDailyCents,
      };
    } else {
      ceilingToApplyCents = verdict.ceilingCents;
    }
  }

  const { data: job, error } = await auth.admin
    .from("ad_publish_jobs")
    .insert({
      workspace_id: workspaceId,
      campaign_id: id,
      video_id: useVideoId,
      meta_account_id: String(body.meta_account_id),
      meta_campaign_id: body.meta_campaign_id ? String(body.meta_campaign_id) : null,
      meta_adset_id: String(body.meta_adset_id),
      meta_page_id: String(body.meta_page_id),
      meta_instagram_user_id: body.meta_instagram_user_id ? String(body.meta_instagram_user_id) : null,
      headlines,
      primary_texts: primaryTexts,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
      cta_type: ctaType,
      destination_url: destinationUrl,
      publish_active: publishActive,
      publish_status: "queued",
      origin,
      created_by: auth.user.id,
    })
    .select("id")
    .single();
  if (error || !job) return NextResponse.json({ error: error?.message || "insert_failed" }, { status: 500 });

  // Post-insert: on refusal, escalate to the CEO (carrying the job id for audit).
  // On allow with a media-buyer-test origin, pin the ad set's daily_budget to the
  // cohort ceiling via updateObjectBudget so the ad set can't quietly spend past
  // it (Meta ABO: the ad set carries the daily_budget, not the ad).
  if (origin === MEDIA_BUYER_TEST_ORIGIN && gateRefusal) {
    await escalateMediaBuyerTestPublishRefusal(auth.admin, {
      workspaceId: workspaceId as string,
      metaAdsetId: String(body.meta_adset_id),
      metaAdAccountId: typeof body.meta_ad_account_row_id === "string" ? body.meta_ad_account_row_id : null,
      projectedDailyCents: gateRefusal.projectedDailyCents,
      reason: gateRefusal.reason,
      diagnosis: gateRefusal.diagnosis,
      ceilingCents: gateRefusal.ceilingCents,
      jobId: job.id,
      campaignId: id,
    });
  } else if (origin === MEDIA_BUYER_TEST_ORIGIN && publishActive && ceilingToApplyCents != null) {
    // Best-effort: cap the ad set's daily budget at the cohort ceiling BEFORE the
    // publisher creates the ACTIVE ad. A failure here doesn't block the publish
    // (the ad-set may already be at the cap, or Meta may reject the update); the
    // publisher's own re-check catches a stale ad-set daily_budget defensively.
    try {
      const token = await getMetaUserToken(workspaceId as string);
      if (token) {
        await updateObjectBudget(token, String(body.meta_adset_id), { dailyBudgetCents: ceilingToApplyCents });
      }
    } catch {
      // swallow — the publisher's origin re-check will still gate the ACTIVE flip
      // if the cap didn't land.
    }
  }

  await inngest.send({ name: "ad-tool/publish-to-meta", data: { workspace_id: workspaceId as string, job_id: job.id } });
  return NextResponse.json({ ok: true, job_id: job.id });
}
