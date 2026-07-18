import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getAdReviewFeedbackForCampaign,
  insertAdReviewFeedback,
  parseAdReviewFeedbackPacket,
} from "@/lib/ads/ad-review-feedback";

// CEO manual-review feedback endpoint (Phase 1 of ceo-manual-ad-review-inline-per-element-
// feedback-routed-to-dahlia-max-render). GET returns the packet history for the campaign;
// POST validates + persists a submitted packet via the SDK chokepoint (never raw .from()).
// Phase 2 will add a dispatcher that reads queued rows and routes each entry.

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

async function requireCampaign(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  workspaceId: string,
) {
  const { data } = await admin
    .from("ad_campaigns")
    .select("id")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .single();
  return data;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;
  const campaign = await requireCampaign(auth.admin, id, workspaceId as string);
  if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const rows = await getAdReviewFeedbackForCampaign(auth.admin, {
    workspaceId: workspaceId as string,
    adCampaignId: id,
  });
  return NextResponse.json({ feedback: rows });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const campaign = await requireCampaign(auth.admin, id, workspaceId as string);
  if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let packet;
  try {
    packet = parseAdReviewFeedbackPacket(body.packet);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 400 },
    );
  }

  try {
    const row = await insertAdReviewFeedback(auth.admin, {
      workspaceId: workspaceId as string,
      adCampaignId: id,
      packet,
      createdBy: auth.user.id,
    });
    // Phase 2 auto-dispatch: enqueue an `ad-review-feedback` agent-jobs row so the box worker's
    // deterministic router (`runAdReviewFeedbackJob` → `enqueueAdReviewFeedback`) plans the
    // per-entry re-drives + the final Max re-QA. Fire-and-forget from the request's perspective —
    // a driver error is logged but does NOT 500 the submit; the row is persisted (status='queued')
    // and a future worker sweep can pick it up. Idempotency lives in the router's
    // compare-and-set on `ad_review_feedback.status`, so a duplicate enqueue is a no-op.
    const { error: jobErr } = await auth.admin.from("agent_jobs").insert({
      workspace_id: workspaceId as string,
      spec_slug: `ad-review-feedback:${row.id}`,
      kind: "ad-review-feedback",
      instructions: JSON.stringify({ ad_review_feedback_id: row.id }),
    });
    if (jobErr) {
      console.error(
        `[ad-review-feedback POST] agent_jobs enqueue failed for feedback=${row.id}: ${jobErr.message}`,
      );
    }
    return NextResponse.json({ feedback: row, dispatched: !jobErr });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
