/**
 * compose-headline — the v3 authoring core: **Angle × Pattern → Headline**.
 *
 * Fills a headline pattern's STRUCTURE with an angle's raw parts (enemy / mechanism / proof /
 * outcome), honoring:
 *  - the pattern's awareness stage (temperature gates which patterns are legal),
 *  - the angle's `evidenceTier` as a proof STYLE (customer_only → lead with the review, never a
 *    clinical claim; science_strong → the stat is fair game),
 *  - the temperature-keyed substitution policy (cold → NO offer/price; warm/hot → our REAL offer),
 *  - our voice (plain text, contractions, no em-dash, Meta 40-char headline cap, no fabrication).
 *
 * The 5 caption variations = call this once per pattern on the same angle. Inline Claude call
 * mirrors [[../ad-meta-copy]] (OPUS_MODEL + the standard messages endpoint). See
 * docs/brain/libraries/compose-headline.md.
 */
import { OPUS_MODEL } from "@/lib/ai-models";
import { withAnthropicRetry } from "@/lib/anthropic-retry";
import { logAiUsage, type ClaudeUsage } from "@/lib/ai-usage";
import type { ProductAngle } from "./angle-palette";
import type { HeadlinePattern, AwarenessStage } from "./headline-patterns";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const META_HEADLINE_CAP = 40;

export interface ComposeHeadlineInput {
  workspaceId: string;
  productTitle: string;
  angle: ProductAngle;
  pattern: HeadlinePattern;
  temperature: AwarenessStage;
  brandProofPoints: string[];
  /** warm/hot only — our REAL offer (from getProductIntelligence.offer). Ignored on cold. */
  realOffer?: string | null;
}

export interface ComposedHeadline {
  headline: string;
  primaryText: string;
  /** which angle-parts the model reported it used — a light provenance trace. */
  usedParts: string[];
}

function buildPrompt(input: ComposeHeadlineInput): string {
  const { angle, pattern, temperature, brandProofPoints, realOffer, productTitle } = input;
  const cold = temperature === "cold";
  const evidenceRule =
    angle.evidenceTier === "customer_only"
      ? "This angle is CUSTOMER-PROVEN but not clinically proven. Lead with the customer review/experience. Do NOT state a clinical or scientific claim as fact."
      : angle.evidenceTier === "science_modest"
        ? "This angle has modest science. You may reference the mechanism or a directional result, but keep claims measured; a real customer phrase is stronger."
        : "This angle is science-strong. The stat/proof is fair to cite plainly.";
  const offerRule = cold
    ? "COLD audience: this is a stranger. NO offers, NO discounts, NO prices, NO 'free' anything, NO urgency. Build intrigue + value + proof only. If the pattern implies an offer slot, fill it with risk-reversal (money-back guarantee) or a value/proof point instead."
    : `WARM/HOT audience (retargeting): they know us. You MAY use our REAL offer${realOffer ? `: "${realOffer}"` : " (money-back guarantee / value framing)"}. Never invent an offer or number.`;

  return [
    `You are Dahlia, direct-response copywriter for ${productTitle} (Superfoods Company). Write ONE ad headline + a 2-sentence primary text.`,
    "",
    "THE ANGLE (the substance — everything must be true to this):",
    `- Theme: ${angle.theme}`,
    `- Problem the customer has: ${angle.problem}`,
    `- Ingredient(s): ${angle.ingredients.join(", ")}`,
    angle.enemy ? `- The ENEMY (what they wrongly rely on instead): ${angle.enemy}` : "",
    angle.mechanism ? `- The MECHANISM (why our ingredient is the real fix): ${angle.mechanism}` : "",
    angle.desiredOutcome ? `- The desired OUTCOME: ${angle.desiredOutcome}` : "",
    angle.proofText ? `- The PROOF: ${angle.proofText}` : "",
    "",
    "THE PATTERN (the structure — flex toward it, do not fill it robotically):",
    `- ${pattern.name}: ${pattern.structure}`,
    `- It consumes these parts: ${pattern.consumes.join(", ")}`,
    pattern.example ? `- Example of this pattern (different product/angle): ${pattern.example}` : "",
    "",
    "RULES:",
    `- ${evidenceRule}`,
    `- ${offerRule}`,
    `- Headline MUST be <= ${META_HEADLINE_CAP} characters. Punchy = short.`,
    "- Plain text only. Use contractions. NO em-dashes. No markdown. Mirror how a real customer talks.",
    "- Never fabricate a claim, number, or review. Only use what THE ANGLE gives you.",
    `- Brand proof you may draw on: ${brandProofPoints.slice(0, 4).join(" · ")}`,
    "",
    'Return ONLY a JSON object: {"headline": "...", "primary_text": "...", "used_parts": ["enemy","mechanism"]}',
  ]
    .filter(Boolean)
    .join("\n");
}

/** Compose one headline from an angle × pattern. Returns null if the API key is absent. */
export async function composeHeadline(input: ComposeHeadlineInput): Promise<ComposedHeadline | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const prompt = buildPrompt(input);
  const out = await withAnthropicRetry(async () => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: OPUS_MODEL, max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    return (await res.json()) as { content?: Array<{ text?: string }>; usage?: ClaudeUsage };
  });

  await logAiUsage({ workspaceId: input.workspaceId, model: OPUS_MODEL, usage: out.usage, purpose: "compose_headline", ticketId: null }).catch(() => {});

  const text = (out.content ?? []).map((c) => c.text ?? "").join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]) as { headline?: string; primary_text?: string; used_parts?: string[] };
  const headline = String(parsed.headline ?? "").trim();
  if (!headline) return null;
  return {
    headline: headline.slice(0, META_HEADLINE_CAP + 20), // soft guard; the gate enforces the hard cap downstream
    primaryText: String(parsed.primary_text ?? "").trim(),
    usedParts: Array.isArray(parsed.used_parts) ? parsed.used_parts.map(String) : [],
  };
}
