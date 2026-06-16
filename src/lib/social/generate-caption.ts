/**
 * PI-grounded caption generation for organic social posts.
 * See docs/brain/specs/automated-social-scheduler.md.
 *
 * Captions are grounded in the real Product Intelligence Engine
 * (product_ingredients + product_ingredient_research + product_benefit_selections)
 * — never invented claims. Per source kind:
 *   avatar / ad_video → benefit-led caption from PI
 *   testimonial       → complements the in-image review (no quote repeat)
 *   resource          → from the post's own summary
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { SONNET_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import { currentDateContext } from "@/lib/social/seasonality";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export type SourceKind = "avatar" | "ad_video" | "testimonial" | "resource" | "promo" | "blog";
export type PostType = "feed" | "reel" | "story";

export interface ProductPI {
  title: string;
  ingredients: string[];
  leadBenefits: string[];       // product_benefit_selections role='lead'
  supportingBenefits: string[]; // role='supporting'
  ingredientHeadlines: string[];// product_ingredient_research benefit_headline
}

/** Load a product's PI grounding. Gracefully returns minimal data if PI is thin. */
export async function loadProductPI(productId: string): Promise<ProductPI | null> {
  const admin = createAdminClient();
  const { data: product } = await admin.from("products").select("title").eq("id", productId).maybeSingle();
  if (!product) return null;

  const [ings, benefits, research] = await Promise.all([
    admin.from("product_ingredients").select("name").eq("product_id", productId).order("display_order"),
    admin.from("product_benefit_selections").select("benefit_name, role").eq("product_id", productId).neq("role", "skip").order("display_order"),
    admin.from("product_ingredient_research").select("benefit_headline").eq("product_id", productId).order("ai_confidence", { ascending: false }).limit(8),
  ]);

  return {
    title: product.title as string,
    ingredients: (ings.data || []).map((i) => i.name as string),
    leadBenefits: (benefits.data || []).filter((b) => b.role === "lead").map((b) => b.benefit_name as string),
    supportingBenefits: (benefits.data || []).filter((b) => b.role === "supporting").map((b) => b.benefit_name as string),
    ingredientHeadlines: (research.data || []).map((r) => r.benefit_headline as string),
  };
}

function piBlock(pi: ProductPI): string {
  const parts = [`Product: ${pi.title}`];
  if (pi.ingredients.length) parts.push(`Ingredients: ${pi.ingredients.join(", ")}`);
  if (pi.leadBenefits.length) parts.push(`Lead benefits: ${pi.leadBenefits.join("; ")}`);
  if (pi.supportingBenefits.length) parts.push(`Supporting benefits: ${pi.supportingBenefits.join("; ")}`);
  if (pi.ingredientHeadlines.length) parts.push(`Ingredient facts: ${pi.ingredientHeadlines.join("; ")}`);
  return parts.join("\n");
}

const SYSTEM = `You write short, scroll-stopping organic social captions for a superfoods/wellness brand's own Facebook and Instagram.

HARD RULES:
- Ground every claim in the PRODUCT INTELLIGENCE provided. NEVER invent ingredients, benefits, studies, or numbers that aren't given.
- No disease/medical claims, no "cures/treats/prevents", no guaranteed-results language.
- Brand voice: warm, real, a little playful. Light emoji use (1-4). No hashtag walls (0-3 tasteful hashtags max, or none).
- Instagram captions can't have clickable links — if a CTA is needed, say "link in bio" or "shop the link in our bio", never paste a URL.
- Output ONLY the caption text. No preamble, no quotes around it, no "Caption:" label.`;

function userPrompt(kind: SourceKind, postType: PostType, pi: ProductPI | null, resourceSummary?: string): string {
  const len = postType === "story" ? "Ultra-short (stories show no caption text — keep it to a punchy line in case it's used as alt/feed)."
    : postType === "reel" ? "Reel caption: a strong hook in the first line, then 1-2 short lines. ~250-400 chars."
    : "Feed caption: hook line + 2-3 short lines of benefit. ~300-500 chars.";
  switch (kind) {
    case "promo":
      return `Write a caption for a SALE / PROMO graphic (the offer + discount are already ON the image). Don't repeat the exact discount text; add urgency + a real product benefit and nudge them to shop (Instagram → "link in bio"). ${len}\n\nPRODUCT INTELLIGENCE:\n${pi ? piBlock(pi) : "(none)"}`;
    case "testimonial":
      return `Write a caption to accompany a 5-star customer TESTIMONIAL card image (the review text, reviewer name, rating, and product are already ON the image). Do NOT repeat the review quote. Add brief social-proof framing plus a real benefit from the PI. ${len}\n\nPRODUCT INTELLIGENCE:\n${pi ? piBlock(pi) : "(none)"}`;
    case "resource":
      return `Write a caption for a blog/recipe RESOURCE post. Summarize the value and invite them to read/try it. ${len}\n\nRESOURCE SUMMARY:\n${(resourceSummary || "").slice(0, 1200)}`;
    case "blog":
      return `Write a caption for a brand-new BLOG ARTICLE we just published. Tease the single most useful takeaway and invite them to read the full article. On Facebook the article link is attached as a clickable card, so DON'T paste a URL; on Instagram say "link in bio". Don't claim it's "trending" or invent stats. ${len}\n\nARTICLE:\n${(resourceSummary || "").slice(0, 1200)}`;
    case "avatar":
      return `Write a caption for a feed post whose image shows a happy customer holding the product. Benefit-led, grounded in the PI. ${len}\n\nPRODUCT INTELLIGENCE:\n${pi ? piBlock(pi) : "(none)"}`;
    case "ad_video":
    default:
      return `Write a caption for a short-form VIDEO (reel) about the product. Hook hard in line one, then the payoff, grounded in the PI. ${len}\n\nPRODUCT INTELLIGENCE:\n${pi ? piBlock(pi) : "(none)"}`;
  }
}

export interface GenerateCaptionArgs {
  workspaceId: string;
  sourceKind: SourceKind;
  postType: PostType;
  productId?: string | null;
  resourceSummary?: string;     // for source_kind='resource'
  now?: Date;                   // the post's scheduled date (for season-correct copy)
  campaignBrief?: string;       // active promo theme — caption should lean into it
}

/** Generate one caption. Returns null on failure (caller can retry or skip). */
export async function generateCaption(args: GenerateCaptionArgs): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const pi = args.productId ? await loadProductPI(args.productId) : null;

  const dateLine = currentDateContext(args.now || new Date());
  const promoLine = args.campaignBrief
    ? `\n\nACTIVE PROMO — lean the caption into this (work it in naturally, don't just tack it on): ${args.campaignBrief}`
    : "";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 500,
      system: SYSTEM,
      messages: [{ role: "user", content: `${dateLine}${promoLine}\n\n${userPrompt(args.sourceKind, args.postType, pi, args.resourceSummary)}` }],
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const text = (json?.content?.[0]?.text || "").trim();
  if (json?.usage) {
    try { await logAiUsage({ workspaceId: args.workspaceId, model: SONNET_MODEL, usage: json.usage, purpose: "social_caption", ticketId: null }); } catch { /* ignore */ }
  }
  return text || null;
}
