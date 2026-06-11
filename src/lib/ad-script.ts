/**
 * Ad tool — Phase 3 script generator.
 *
 * Turns a chosen angle (+ length) into a Hook / Body / CTA script, then runs the
 * Direct Response Validator. Retries up to 3x on fatal violations before
 * surfacing them to the operator. The render gate (Phase 5) validates again.
 *
 * See docs/brain/specs/ad-tool.md Phase 3.
 */
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import { HOOK_FORMULAS, LIFE_FORCE_8, DEFAULT_BANNED_WORDS } from "@/lib/ad-tool-config";
import type { AngleGeneratorInput, ProductAdAngle } from "@/lib/ad-types";
import { validateAdScript, type Violation, estimateSpokenSeconds } from "@/lib/ad-validator";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim();

export interface GenerateScriptArgs {
  angle: ProductAdAngle;
  inputs: AngleGeneratorInput;
  lengthSec: 15 | 30;
  bannedWords?: string[];
  workspaceId: string;
  seed?: number; // varies the regenerate output
}

export interface GeneratedScript {
  ok: boolean;
  script: string;
  hook: string;
  body: string;
  cta: string;
  violations: Violation[];
  attempts: number;
  reason?: string;
}

function hookTemplate(slug: string): string {
  return HOOK_FORMULAS.find((h) => h.slug === slug)?.template || "";
}

function buildSystem(args: GenerateScriptArgs): string {
  const banned = (args.bannedWords?.length ? args.bannedWords : DEFAULT_BANNED_WORDS).join(", ");
  const talkSec = args.lengthSec - 1; // 1s buffer
  return `You write spoken scripts for direct-response paid-social video ads. Plain spoken words only — no stage directions, no markdown, no emojis.

STRUCTURE (label each section on its own line):
HOOK: lands in the first 2 seconds, uses the "${args.angle.hook_slug}" formula ("${hookTemplate(args.angle.hook_slug)}"). No "Hey/Hi/Welcome/Introducing", no brand-name opener.
BODY: problem → agitation → solution. <= 60% of the total. Benefits first; ingredients only as supporting evidence, never in the first 5 seconds.
CTA: imperative + the urgency lever "${args.angle.urgency_lever}". Never a soft "learn more".

TARGET LENGTH: ~${talkSec}s of spoken content (≈ ${Math.round(talkSec * 2.6)} words total). Do NOT exceed 30s.
LIFE FORCE 8 TARGET: ${args.angle.lf8_slot}. ${LIFE_FORCE_8[args.angle.lf8_slot]}.

HARD RULES:
- Every product claim must trace to the provided leading promise / lead benefits / ingredient science. Do not invent outcomes.
- You MAY cite a customer review as backing ("Real customer: '...'"), but the central promise must rest on a tier-1/tier-2 benefit, not a review.
- NEVER use these banned soft words: ${banned}.
- The promised benefit is: "${args.angle.lead_benefit_anchor}".

Return ONLY the three labelled lines (HOOK:, BODY:, CTA:).`;
}

function buildUser(args: GenerateScriptArgs): string {
  return `Angle:\n${JSON.stringify(
    {
      hook_one_liner: args.angle.hook_one_liner,
      pain_now: args.angle.pain_now,
      desired_outcome: args.angle.desired_outcome,
      proof_anchor: args.angle.proof_anchor,
      enemy: args.angle.enemy,
      vibe_tags: args.angle.vibe_tags,
    },
    null,
    2,
  )}\n\nSource data:\n${JSON.stringify(
    {
      hero_headline: args.inputs.hero_headline,
      benefit_bar: args.inputs.benefit_bar,
      lead_benefits: args.inputs.lead_benefits,
      ingredient_science: args.inputs.ingredient_science,
      proof_quotes: args.inputs.proof_quotes,
      guarantee_copy: args.inputs.guarantee_copy,
    },
    null,
    2,
  )}\n\nSeed: ${args.seed ?? 0}. Write the script.`;
}

function splitSections(text: string): { hook: string; body: string; cta: string } {
  const hook = /hook:\s*([\s\S]*?)(?=\n\s*body:|\n\s*cta:|$)/i.exec(text)?.[1]?.trim() || "";
  const body = /body:\s*([\s\S]*?)(?=\n\s*cta:|$)/i.exec(text)?.[1]?.trim() || "";
  const cta = /cta:\s*([\s\S]*?)$/i.exec(text)?.[1]?.trim() || "";
  return { hook, body, cta };
}

async function callOpus(args: GenerateScriptArgs): Promise<{ text: string; usage: any } | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: OPUS_MODEL,
      max_tokens: 1200,
      system: buildSystem(args),
      messages: [{ role: "user", content: buildUser(args) }],
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return { text: (json?.content?.[0]?.text || "").trim(), usage: json?.usage };
}

/** Generate a validated script, retrying up to `maxAttempts` on fatal violations. */
export async function generateScript(args: GenerateScriptArgs, maxAttempts = 3): Promise<GeneratedScript> {
  if (!ANTHROPIC_API_KEY) return { ok: false, script: "", hook: "", body: "", cta: "", violations: [], attempts: 0, reason: "no_api_key" };

  let last: GeneratedScript | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = await callOpus({ ...args, seed: (args.seed ?? 0) + attempt });
    if (!out) return { ok: false, script: "", hook: "", body: "", cta: "", violations: [], attempts: attempt, reason: "opus_error" };
    if (out.usage) {
      try {
        await logAiUsage({ workspaceId: args.workspaceId, model: OPUS_MODEL, usage: out.usage, purpose: "ad_script_generation", ticketId: null });
      } catch {}
    }
    const { hook, body, cta } = splitSections(out.text);
    const script = [hook, body, cta].filter(Boolean).join("\n");
    const v = validateAdScript(script, args.angle, args.inputs, { bannedWords: args.bannedWords });
    last = { ok: v.ok, script, hook, body, cta, violations: v.violations, attempts: attempt };
    if (v.ok) return last;
  }
  return last || { ok: false, script: "", hook: "", body: "", cta: "", violations: [], attempts: maxAttempts, reason: "exhausted" };
}

export { estimateSpokenSeconds };
