/**
 * Smart-popup decider (storefront-mvp Phase 4b).
 *
 * `decideByRules` is deterministic, instant, free — it stays SILENT for
 * locked-in buyers (protect margin) and intervenes only on hesitation /
 * indecision. `challengeWithHaiku` is the A/B challenger: same signature,
 * classifies the hesitation type from the messy timeline so we can prove
 * "smart" beats a dumb timer and tune the prompt. The API route enforces
 * the budget (one AI call per candidate session + a daily cap).
 *
 * Two intervention modes:
 *   discount — price hesitation: they want it but are stuck on price.
 *   quiz     — indecision: they can't choose / are comparing.
 */

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_TIMEOUT_MS = 4000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export interface PopupTimeline {
  dwell_ms: number;
  max_scroll_pct: number;
  scroll_reversals: number;
  chapter_views: number;
  price_viewed: boolean;
  price_dwell_ms: number;
  scroll_to_price_clicks: number;
  customize_visited: boolean;
  returned_to_pdp_from_customize: boolean;
  tab_away_return: boolean;
  rage_clicks: number;
  pack_selected: boolean;
  is_bot: boolean;
  already_shown: boolean;
  returning_customer_with_sub: boolean;
}

export type PopupVariant = "discount" | "quiz" | "none";

export interface PopupDecision {
  show: boolean;
  variant: PopupVariant;
  reason: string;
  decided_by: "rules" | "haiku";
}

/**
 * Candidacy gate (4a) — disqualify before any decision. Cheap, no AI,
 * protects spend. Returns a reason string when disqualified, else null.
 */
export function disqualifyReason(t: PopupTimeline): string | null {
  if (t.is_bot) return "bot";
  if (t.pack_selected) return "already_selecting";
  if (t.already_shown) return "already_shown";
  if (t.returning_customer_with_sub) return "returning_subscriber";
  if (t.dwell_ms < 20_000) return "dwell_too_short";
  // No real engagement: barely scrolled AND saw < 2 chapters.
  if (t.max_scroll_pct < 20 && t.chapter_views < 2) return "no_engagement";
  return null;
}

/**
 * Deterministic decision. Runs AFTER the candidacy gate (assumes the
 * visitor is a live, engaged, non-converting human).
 */
export function decideByRules(t: PopupTimeline): PopupDecision {
  const dq = disqualifyReason(t);
  if (dq) return { show: false, variant: "none", reason: dq, decided_by: "rules" };

  // ── The quiz variant moved to a visible PDP chapter (SurveyChapter) ──
  // The popup is now discount-only: its job is the price-moment intervention.
  // The old indecision→quiz triggers (rage taps, long-compare) are retired here
  // because the survey now lives in-page after the hero, not in a popup. The
  // `quiz` variant type is kept only for the ?popup=quiz QA preview.

  // ── Price hesitation → discount (they want it, stuck on price) ────
  // Highest confidence: clicked a scroll-to-price CTA, reached pricing,
  // didn't select.
  if (t.scroll_to_price_clicks >= 1 && t.price_viewed && !t.pack_selected) {
    return { show: true, variant: "discount", reason: "cta_to_price_no_select", decided_by: "rules" };
  }
  if (t.customize_visited && t.returned_to_pdp_from_customize) {
    return { show: true, variant: "discount", reason: "customize_then_back", decided_by: "rules" };
  }
  if (t.price_viewed && t.price_dwell_ms >= 15_000 && !t.pack_selected) {
    return { show: true, variant: "discount", reason: "price_dwell_no_select", decided_by: "rules" };
  }
  if (t.price_viewed && t.scroll_reversals >= 3 && !t.pack_selected) {
    return { show: true, variant: "discount", reason: "price_yoyo", decided_by: "rules" };
  }
  if (t.tab_away_return) {
    // The mobile exit-intent replacement (no mouseleave on touch).
    return { show: true, variant: "discount", reason: "tab_away_return", decided_by: "rules" };
  }

  return { show: false, variant: "none", reason: "no_hesitation_signal", decided_by: "rules" };
}

/**
 * Haiku A/B challenger — classify the hesitation type from the raw
 * timeline. Returns null on any failure / timeout / missing key so the
 * caller falls back to the rules decision. Only called for candidate
 * sessions within the daily budget (enforced by the route).
 */
export async function challengeWithHaiku(t: PopupTimeline): Promise<PopupDecision | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const dq = disqualifyReason(t);
  if (dq) return { show: false, variant: "none", reason: dq, decided_by: "haiku" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 120,
        system:
          `You decide whether to show a single behavioral discount popup to a storefront visitor. ` +
          `Protect margin: do NOT interrupt a decisive buyer. Only intervene on genuine price hesitation.\n` +
          `Variants:\n` +
          `- "discount": price hesitation — they want the product but are stuck on price (dwelled on pricing, bounced to customize and back, yo-yo'd around price, tabbed away and returned).\n` +
          `- "none": no clear price hesitation, or signs they're already deciding.\n` +
          `Reply with ONLY compact JSON: {"show": boolean, "variant": "discount"|"none", "reason": "<short_snake_case>"}.`,
        messages: [{ role: "user", content: `Visitor session signals:\n${JSON.stringify(t)}` }],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = json.content?.[0]?.text?.trim() || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { show?: boolean; variant?: string; reason?: string };
    // Popup is discount-only now (survey moved to a chapter). Coerce anything
    // that isn't "discount" to "none" so a stray "quiz" never renders.
    const variant: PopupVariant = parsed.variant === "discount" ? "discount" : "none";
    return {
      show: !!parsed.show && variant === "discount",
      variant: parsed.show && variant === "discount" ? "discount" : "none",
      reason: parsed.reason || "haiku",
      decided_by: "haiku",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
