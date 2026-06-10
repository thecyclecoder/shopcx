/**
 * POST /api/popup/decide  (storefront-mvp Phase 4b)
 *
 * The client runs the cheap candidacy gate locally, then — when a
 * hesitation trigger fires — POSTs its session timeline here exactly once.
 * We decide {show, variant, reason}, compute the live offer stack, log the
 * decision (outcome funnel seeded), and return it.
 *
 * Budget discipline: ONE decision per session (the popup_decisions row is
 * unique on (workspace_id, anonymous_id) — a repeat call returns the cached
 * decision). Haiku is the A/B challenger behind a daily cap; over cap, or
 * on the rules side of the split, we use the deterministic rules.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decideByRules, challengeWithHaiku, type PopupTimeline } from "@/lib/popup/decide";
import { computePopupOffer } from "@/lib/popup/offer";

const HAIKU_DAILY_CAP = 300; // max Haiku decisions/day across the workspace
const HAIKU_AB_SPLIT = 0.5; // fraction of candidates routed to Haiku

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    workspace_id?: string;
    product_id?: string;
    anonymous_id?: string;
    timeline?: Partial<PopupTimeline>;
    preview?: boolean;
    variant?: "discount" | "quiz";
  };
  if (!body.workspace_id || !body.anonymous_id) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const admin = createAdminClient();

  // Preview/QA (?popup=...): force-show the requested variant with the real
  // computed offer, skipping the candidacy gate, the rules, the per-session
  // cache, and the outcome logging (so previews don't pollute analytics).
  if (body.preview && body.product_id) {
    const offer = await computePopupOffer(body.workspace_id, body.product_id);
    return NextResponse.json({ show: true, variant: body.variant || "discount", reason: "preview", offer: offer || {} });
  }

  // One decision per session — return the cached one if present.
  const { data: existing } = await admin
    .from("popup_decisions")
    .select("variant, reason, offer, decided_by")
    .eq("workspace_id", body.workspace_id)
    .eq("anonymous_id", body.anonymous_id)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({
      show: existing.variant !== "none",
      variant: existing.variant,
      reason: existing.reason,
      offer: existing.offer,
      cached: true,
    });
  }

  const timeline = normalizeTimeline(body.timeline || {});

  // Rules first (free, deterministic).
  let decision = decideByRules(timeline);

  // Haiku A/B challenger — only for candidates (rules didn't already
  // disqualify on hard grounds), within the daily budget, on the AI side
  // of a stable per-session split.
  const hardDq = ["bot", "already_selecting", "already_shown", "returning_subscriber"].includes(decision.reason);
  if (!hardDq && abSide(body.anonymous_id) < HAIKU_AB_SPLIT) {
    const todayIso = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString();
    const { count } = await admin
      .from("popup_decisions")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", body.workspace_id)
      .eq("decided_by", "haiku")
      .gte("created_at", todayIso);
    if ((count || 0) < HAIKU_DAILY_CAP) {
      const haiku = await challengeWithHaiku(timeline);
      if (haiku) decision = haiku;
    }
  }

  // Compute the offer only when we're going to show something.
  let offer: Record<string, unknown> = {};
  if (decision.show && body.product_id) {
    const computed = await computePopupOffer(body.workspace_id, body.product_id);
    if (computed) offer = computed as unknown as Record<string, unknown>;
  }

  // Only PERSIST (and thus cache) a decision that's final for the session: it
  // SHOWED, or it's a hard disqualifier (bot / already-selecting / already-shown
  // / returning-subscriber). A soft "no hesitation yet" must NOT cache — else a
  // borderline first check locks the session and the popup can never appear as
  // the visitor's hesitation builds.
  const hardNo = ["bot", "already_selecting", "already_shown", "returning_subscriber"].includes(decision.reason);
  if (decision.show || hardNo) {
    const { data: sess } = await admin
      .from("storefront_sessions")
      .select("id, customer_id")
      .eq("workspace_id", body.workspace_id)
      .eq("anonymous_id", body.anonymous_id)
      .maybeSingle();
    await admin
      .from("popup_decisions")
      .upsert(
        {
          workspace_id: body.workspace_id,
          anonymous_id: body.anonymous_id,
          session_id: (sess?.id as string) || null,
          customer_id: (sess?.customer_id as string) || null,
          variant: decision.variant,
          reason: decision.reason,
          decided_by: decision.decided_by,
          offer,
          shown: decision.show,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,anonymous_id", ignoreDuplicates: true },
      )
      .then(() => undefined, () => undefined);
  }

  return NextResponse.json({
    show: decision.show,
    variant: decision.variant,
    reason: decision.reason,
    offer,
  });
}

function normalizeTimeline(t: Partial<PopupTimeline>): PopupTimeline {
  return {
    dwell_ms: Number(t.dwell_ms) || 0,
    max_scroll_pct: Number(t.max_scroll_pct) || 0,
    scroll_reversals: Number(t.scroll_reversals) || 0,
    chapter_views: Number(t.chapter_views) || 0,
    price_viewed: !!t.price_viewed,
    price_dwell_ms: Number(t.price_dwell_ms) || 0,
    scroll_to_price_clicks: Number(t.scroll_to_price_clicks) || 0,
    customize_visited: !!t.customize_visited,
    returned_to_pdp_from_customize: !!t.returned_to_pdp_from_customize,
    tab_away_return: !!t.tab_away_return,
    rage_clicks: Number(t.rage_clicks) || 0,
    pack_selected: !!t.pack_selected,
    is_bot: !!t.is_bot,
    already_shown: !!t.already_shown,
    returning_customer_with_sub: !!t.returning_customer_with_sub,
  };
}

/** Stable 0..1 split from the anonymous_id so a session always lands on the same arm. */
function abSide(anonymousId: string): number {
  let h = 0;
  for (let i = 0; i < anonymousId.length; i++) h = (h * 31 + anonymousId.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}
