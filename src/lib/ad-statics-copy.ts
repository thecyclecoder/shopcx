/**
 * Ad tool — COPY generation for the cold-50+ static archetypes.
 *
 * The advertorial / big-claim / before-after archetypes carry generated copy
 * (the testimonial + authority archetypes use REAL review / endorsement text
 * verbatim, so they don't pass through here). One Opus call per archetype, fed
 * from the Product-Intelligence tiers via `loadAngleInputs`, then gated through
 * `validateAdScript` for banned words. Mirrors `ad-meta-copy.ts` / `ad-script.ts`.
 *
 * Hard copy rules (Dylan, 2026-06-15 — see docs/brain/specs/killer-statics.md):
 *  - Anchor EVERY angle to the core desires: weight loss · fighting aging · being
 *    the best version of yourself · being noticed / liked. NEVER lead with the
 *    functional/secondary benefits (energy, "no jitters", "no 2pm crash", focus).
 *  - No banned words, no medical claims, American English, cold-50+ trust voice.
 *
 * Every generator degrades gracefully: if there's no API key or the model output
 * doesn't parse, it returns proven default copy so the render pipeline never fails.
 */
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import { validateAdScript } from "@/lib/ad-validator";
import { resolveAdToolSettings } from "@/lib/ad-tool-config";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AngleGeneratorInput, ProductAdAngle } from "@/lib/ad-types";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export interface AdvertorialCopy { category: string; headline: string; dek: string; body: string[]; heroCaption: string; }
export interface BigClaimCopy { eyebrow: string; hook: string; emphasis: string; reveal: string; }
export interface BeforeAfterCopy { headline: string; beforeText: string; afterText: string; }

/** Advertorial hero is an avatar (lifestyle) or an ingredient shot — drives the copy register. */
export type AdvertorialHeroKind = "avatar" | "ingredient";

const CORE_DESIRE_RULES = `Anchor the copy to the product's CORE desires: weight loss, fighting aging, becoming the best version of yourself, and being noticed/liked (social approval). Do NOT lead with functional or secondary benefits — energy, "no jitters", "no 2pm crash", or focus. Energy is at most a supporting mechanism, never the promise. The audience is cold and 50+, so they convert on trust, legibility and credibility — write plainly, no hype, no medical claims, American English.`;

function banned(settings: { banned_words?: string[] }): string[] {
  return settings.banned_words || [];
}

function factsBlock(inp: AngleGeneratorInput): string {
  const benefits = (inp.lead_benefits || []).map((b) => b.name).filter(Boolean).slice(0, 6);
  const science = (inp.ingredient_science || []).map((s) => `${s.ingredient_name}: ${s.benefit_headline}`).filter(Boolean).slice(0, 5);
  return [
    `Product: "${inp.product_title}"`,
    `Leading promise: ${inp.hero_headline || "(none)"} — ${inp.hero_subheadline || ""}`.trim(),
    `Key benefits: ${benefits.join("; ") || "(see promise)"}`,
    `Ingredient science: ${science.join("; ") || "(none)"}`,
    `Guarantee: ${inp.guarantee_copy || "(none)"}`,
    `Social proof: ${inp.credibility?.review_count ? `${inp.credibility.review_count.toLocaleString()} reviews, ${(inp.credibility.review_avg || 5).toFixed(1)}★` : "(none)"}`,
    `Target customer: ${inp.target_customer || "adults 50+"}`,
  ].join("\n");
}

function angleBlock(angle: ProductAdAngle | null): string {
  if (!angle) return "";
  return `\nLead angle to honor:\n- Hook: ${angle.hook_one_liner || ""}\n- Anchor benefit (verbatim): ${angle.lead_benefit_anchor || ""}\n- Pain: ${angle.pain_now || ""}\n- Desired outcome: ${angle.desired_outcome || ""}\n- Enemy: ${angle.enemy || "(none)"}`;
}

async function callOpusJSON(workspaceId: string, system: string, user: string, purpose: string): Promise<any | null> {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: OPUS_MODEL, max_tokens: 1100, system, messages: [{ role: "user", content: user }] }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    await logAiUsage({ workspaceId, model: OPUS_MODEL, usage: out.usage, purpose, ticketId: null }).catch(() => {});
    const text = out?.content?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Lenient validator gate: only reject on banned-word violations (the openers /
 *  length / soft-CTA codes are video-specific and would false-positive on copy). */
function hasBannedWord(text: string, inp: AngleGeneratorInput, bannedWords: string[]): boolean {
  try {
    const res = validateAdScript(text, null, inp, { bannedWords });
    return res.violations.some((v) => v.severity === "fatal" && v.code === "banned_word");
  } catch {
    return false;
  }
}

async function settingsFor(workspaceId: string): Promise<{ banned_words?: string[] }> {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("ad_tool_settings").eq("id", workspaceId).single();
  return resolveAdToolSettings(ws?.ad_tool_settings);
}

// ── Advertorial ──────────────────────────────────────────────────────────────
export async function generateAdvertorialCopy(workspaceId: string, inp: AngleGeneratorInput, angle: ProductAdAngle | null, heroKind: AdvertorialHeroKind): Promise<AdvertorialCopy> {
  const fallback: AdvertorialCopy = {
    category: "HEALTH",
    headline: `The Morning Coffee Helping People Over 50 Feel Like Themselves Again`,
    dek: `Twelve clinically studied superfoods in one delicious cup — built around the goals that matter most after 50.`,
    body: [
      `For a lot of people over 50, the things that used to work stop working. A growing number are starting their day with one delicious cup built around 12 clinically studied superfoods.`,
      `Chosen for healthy weight, antioxidants that fight visible aging, and the kind of vitality people notice — so the coffee you already love quietly works with you.`,
    ],
    heroCaption: heroKind === "ingredient" ? "The superfoods inside every cup." : "Real customers are swapping their morning cup.",
  };
  const settings = await settingsFor(workspaceId);
  const heroNote = heroKind === "ingredient"
    ? `The hero image is an ingredient/superfood shot, so the dek + caption can reference the ingredients.`
    : `The hero image is a real customer holding the product, so frame it as a customer story.`;
  const system = `You write native-feeling editorial "advertorial" copy — it should read like a trustworthy health-magazine article, NOT a loud DTC ad (the un-ad look is the conversion mechanism for a cold 50+ reader). ${CORE_DESIRE_RULES}`;
  const user = `${factsBlock(inp)}${angleBlock(angle)}\n${heroNote}\n\nWrite the advertorial copy. Return ONLY JSON:\n{"category":"one or two words, e.g. HEALTH or WEIGHT LOSS","headline":"serif magazine headline, ~10-14 words, curiosity/benefit-led, NO brand name first","dek":"one-sentence standfirst under the headline","body":["short paragraph 1 (2-3 sentences)","short paragraph 2 (2-3 sentences)"],"heroCaption":"one short italic photo caption"}\nNo banned words: ${banned(settings).join(", ") || "(none)"}.`;
  const j = await callOpusJSON(workspaceId, system, user, "ad_static_advertorial_copy");
  if (!j) return fallback;
  const body = Array.isArray(j.body) ? j.body.map((s: any) => String(s).trim()).filter(Boolean).slice(0, 3) : [];
  const out: AdvertorialCopy = {
    category: String(j.category || fallback.category).toUpperCase().slice(0, 18),
    headline: String(j.headline || fallback.headline).trim(),
    dek: String(j.dek || fallback.dek).trim(),
    body: body.length ? body : fallback.body,
    heroCaption: String(j.heroCaption || fallback.heroCaption).trim(),
  };
  if (hasBannedWord([out.headline, out.dek, ...out.body].join(" "), inp, banned(settings))) return fallback;
  return out;
}

// ── Big-claim (contrarian hook poster) ───────────────────────────────────────
export async function generateBigClaimCopy(workspaceId: string, inp: AngleGeneratorInput, angle: ProductAdAngle | null): Promise<BigClaimCopy> {
  const fallback: BigClaimCopy = {
    eyebrow: "After 50, read this",
    hook: "Your coffee is aging you.",
    emphasis: "aging you",
    reveal: "This one fights back — 12 superfoods studied for antioxidants, weight, and firmer, younger-looking skin.",
  };
  const settings = await settingsFor(workspaceId);
  const system = `You write contrarian, pattern-interrupt HOOK posters — a single shock statement that attacks a common assumption to stop the thumb, then a turn line that reframes to the product. It is NOT a stat. ${CORE_DESIRE_RULES} Stay compliant: no unrealistic numeric promises as the ad's own claim.`;
  const user = `${factsBlock(inp)}${angleBlock(angle)}\n\nWrite ONE contrarian hook poster. The "emphasis" MUST be a substring of "hook" (it gets highlighted). Return ONLY JSON:\n{"eyebrow":"tiny qualifier line, e.g. 'After 50, read this'","hook":"3-7 word shock statement attacking an assumption","emphasis":"the 1-3 word fragment of the hook to highlight","reveal":"one sentence that turns it toward the product solution"}\nNo banned words: ${banned(settings).join(", ") || "(none)"}.`;
  const j = await callOpusJSON(workspaceId, system, user, "ad_static_bigclaim_copy");
  if (!j) return fallback;
  const hook = String(j.hook || fallback.hook).trim();
  let emphasis = String(j.emphasis || "").trim();
  if (!emphasis || !hook.includes(emphasis)) emphasis = ""; // template only highlights when it's a real substring
  const out: BigClaimCopy = {
    eyebrow: String(j.eyebrow || fallback.eyebrow).trim(),
    hook,
    emphasis,
    reveal: String(j.reveal || fallback.reveal).trim(),
  };
  if (hasBannedWord([out.hook, out.reveal].join(" "), inp, banned(settings))) return fallback;
  return out;
}

// ── Before / after (problem → solution) ──────────────────────────────────────
export async function generateBeforeAfterCopy(workspaceId: string, inp: AngleGeneratorInput, angle: ProductAdAngle | null): Promise<BeforeAfterCopy> {
  const fallback: BeforeAfterCopy = {
    headline: "The transformation people are talking about",
    beforeText: "Where she started.",
    afterText: "Lighter, glowing — and getting compliments.",
  };
  const settings = await settingsFor(workspaceId);
  const system = `You write before/after problem→solution copy for a cold 50+ audience. ${CORE_DESIRE_RULES} Keep specific weight-loss numbers OUT of the ad's own claims (those belong only in real testimonial quotes).`;
  const user = `${factsBlock(inp)}${angleBlock(angle)}\n\nWrite the before/after copy. Return ONLY JSON:\n{"headline":"short uppercase-ready headline over the two panels","beforeText":"one short line describing the 'before' state","afterText":"one short line describing the 'after' state (lighter, noticed, best self)"}\nNo banned words: ${banned(settings).join(", ") || "(none)"}.`;
  const j = await callOpusJSON(workspaceId, system, user, "ad_static_beforeafter_copy");
  if (!j) return fallback;
  const out: BeforeAfterCopy = {
    headline: String(j.headline || fallback.headline).trim(),
    beforeText: String(j.beforeText || fallback.beforeText).trim(),
    afterText: String(j.afterText || fallback.afterText).trim(),
  };
  if (hasBannedWord([out.headline, out.beforeText, out.afterText].join(" "), inp, banned(settings))) return fallback;
  return out;
}
