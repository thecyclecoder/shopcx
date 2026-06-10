/**
 * Ad tool — Meta ad COPY generation.
 *
 * Turns a finished campaign (lead angle + video script + product intelligence)
 * into Meta ad copy: a headline + 3 variations and a primary text + 3 variations
 * (+ an optional description). Direct-response voice, on-brand, within Meta's
 * length sweet spots. Mirrors `ad-script.ts` (Opus via the Anthropic API).
 * See docs/brain/lifecycles/ad-publish.md.
 */
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import { loadAngleInputs } from "@/lib/ad-angles";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveAdToolSettings } from "@/lib/ad-tool-config";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/** Meta call-to-action button enum (curated subset of Meta's list). */
export const META_CTA_TYPES = [
  "SHOP_NOW",
  "LEARN_MORE",
  "GET_OFFER",
  "ORDER_NOW",
  "BUY_NOW",
  "SIGN_UP",
  "SUBSCRIBE",
  "GET_QUOTE",
  "SEE_MORE",
] as const;
export type MetaCtaType = (typeof META_CTA_TYPES)[number];

export interface MetaCopy {
  headlines: string[]; // 4: headline + 3 variations
  primaryTexts: string[]; // 4: primary text + 3 variations
  description: string;
}

function buildPrompt(args: {
  productTitle: string;
  angleHook: string;
  script: string;
  benefits: string[];
  guarantee: string;
  reviewCount: number;
  reviewAvg: number;
  bannedWords: string[];
}): string {
  return `You write high-converting Meta (Facebook/Instagram) ad copy for direct-response paid social. Product: "${args.productTitle}".

Lead angle / hook: ${args.angleHook || "(use the script's angle)"}
The video ad's spoken script (for tone + angle alignment):
"""${args.script}"""

Supporting facts (use only what's true here):
- Key benefits: ${args.benefits.slice(0, 6).join("; ") || "(see script)"}
- Guarantee: ${args.guarantee || "(none stated)"}
- Social proof: ${args.reviewCount > 0 ? `${args.reviewCount.toLocaleString()}+ reviews, ${args.reviewAvg.toFixed(1)}★` : "(none)"}

Write:
- 4 HEADLINES (the bold title under the video). Punchy, ≤40 characters each, benefit- or curiosity-led. Distinct from each other.
- 4 PRIMARY TEXTS (the body above the video). 1–3 short sentences, scroll-stopping hook first, direct-response, ends implying the offer. No emoji spam (≤1 emoji). Distinct angles across the 4.
- 1 DESCRIPTION (optional small link description). ≤30 chars, e.g. an offer line.

Rules: real, specific, no hype words, no false claims, no medical claims. Do NOT use any of these banned words: ${args.bannedWords.join(", ") || "(none)"}. American English.

Return ONLY JSON, no prose:
{"headlines":["...","...","...","..."],"primary_texts":["...","...","...","..."],"description":"..."}`;
}

function parseCopy(text: string): MetaCopy | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const headlines = (Array.isArray(j.headlines) ? j.headlines : []).map((s: any) => String(s).trim()).filter(Boolean).slice(0, 4);
    const primaryTexts = (Array.isArray(j.primary_texts) ? j.primary_texts : []).map((s: any) => String(s).trim()).filter(Boolean).slice(0, 4);
    if (!headlines.length || !primaryTexts.length) return null;
    return { headlines, primaryTexts, description: String(j.description || "").trim() };
  } catch {
    return null;
  }
}

/** Generate Meta ad copy for a campaign (loads angle + product intelligence). */
export async function generateMetaCopy(workspaceId: string, campaignId: string): Promise<MetaCopy | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("ad_campaigns")
    .select("product_id, script_text, angle_id")
    .eq("id", campaignId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!campaign?.product_id) return null;

  const inputs = await loadAngleInputs(campaign.product_id);
  let angleHook = "";
  if (campaign.angle_id) {
    const { data: angle } = await admin.from("product_ad_angles").select("hook_one_liner, lead_benefit_anchor").eq("id", campaign.angle_id).maybeSingle();
    angleHook = angle?.hook_one_liner || angle?.lead_benefit_anchor || "";
  }
  const { data: ws } = await admin.from("workspaces").select("ad_tool_settings").eq("id", workspaceId).single();
  const settings = resolveAdToolSettings(ws?.ad_tool_settings);

  const prompt = buildPrompt({
    productTitle: inputs.product_title,
    angleHook,
    script: campaign.script_text || "",
    benefits: (inputs.lead_benefits || []).map((b: any) => b.benefit_name || b.benefit_headline).filter(Boolean),
    guarantee: inputs.guarantee_copy || "",
    reviewCount: inputs.credibility?.review_count ?? 0,
    reviewAvg: inputs.credibility?.review_avg ?? 0,
    bannedWords: settings.banned_words || [],
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: OPUS_MODEL, max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  await logAiUsage({ workspaceId, model: OPUS_MODEL, usage: out.usage, purpose: "ad_meta_copy", ticketId: null }).catch(() => {});
  const text = out?.content?.[0]?.text || "";
  return parseCopy(text);
}
