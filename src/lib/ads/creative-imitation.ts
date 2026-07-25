/**
 * creative-imitation — the Phase-2 verify-then-reword surface for Dahlia's competitor-ad
 * adaptation loop (dahlia-competitor-ad-adaptation-overlay-render Phase 2). The current
 * firewall stops fabrication (rail 1 + never-fabricate); this module adds the POSITIVE
 * adaptation instinct — for each benefit in the competitor's proven angle, VERIFY the
 * analogous benefit exists in OUR `product_benefit_selections` with `customer_confirmed=true`
 * and REWORD it (never reinvent, never invent). Substitute a genuinely-lacked benefit with a
 * different confirmed one. See [[../../../docs/brain/reference/competitor-ad-adaptation]] Part 1.
 *
 * Pure + deterministic — no I/O. Consumed by:
 *   • [[creative-brief]] `buildCreativeBrief` — populates `brief.confirmedBenefits` from `pi.benefits`;
 *   • [[../../../.claude/skills/dahlia-copy-author/SKILL.md]] IMITATE-DEBRANDED — VERIFY-THEN-REWORD rule
 *     reads `brief.confirmedBenefits` as the catalog to check the competitor's benefits against.
 */
import type { ProductIntelligence } from "@/lib/product-intelligence";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * A benefit that is **CUSTOMER-CONFIRMED** for our product — real customers report it in
 * `product_benefit_selections.customer_confirmed=true` (curated by the CEO / seed pass). The
 * `softPhrasings` come verbatim from the row's `customer_phrases` so Dahlia can pick a naturally-
 * spoken reword ("skin is smoother" / "no more bloating") instead of inventing one.
 */
export interface ConfirmedBenefit {
  benefitName: string;
  softPhrasings: string[];
  /** `'lead'` or `'supporting'` — from `product_benefit_selections.role`. Only these two roles are
   *  eligible; a `skip`-role benefit is deliberately excluded from acquisition copy. */
  role: "lead" | "supporting";
}

/** Read every CUSTOMER-CONFIRMED benefit (role ∈ {lead, supporting}) from a hydrated
 *  ProductIntelligence into the ConfirmedBenefit shape. Preserves display order. Pure. */
export function selectConfirmedBenefits(pi: ProductIntelligence): ConfirmedBenefit[] {
  const rows = (pi.benefits as Row[]) ?? [];
  const out: ConfirmedBenefit[] = [];
  for (const b of rows) {
    if (b.customer_confirmed !== true) continue;
    const role = str(b.role);
    if (role !== "lead" && role !== "supporting") continue;
    const benefitName = str(b.benefit_name).trim();
    if (!benefitName) continue;
    const softPhrasings = Array.isArray(b.customer_phrases)
      ? (b.customer_phrases as unknown[]).map(str).map((s) => s.trim()).filter(Boolean).slice(0, 8)
      : [];
    out.push({ benefitName, softPhrasings, role: role as ConfirmedBenefit["role"] });
  }
  return out;
}

// ── Benefit-dimension taxonomy ───────────────────────────────────────────────
// Keeps the 'diverse benefit stack' rule (Part 1 § "Diverse benefit stack") deterministic:
// don't spend two of four beats on the same dimension. Names the dimensions the competitor-
// adaptation reference actually enumerates + a couple of standard neighbors. Anything that
// doesn't fit stays as `null` (unknown → treated as its own bucket by `hasDiverseBenefitStack`).
type Dimension =
  | "skin"
  | "hair"
  | "weight"
  | "appetite"
  | "digestion"
  | "sleep"
  | "focus"
  | "energy"
  | "immunity"
  | "mood"
  | "joint";

const DIMENSION_LEXICONS: Record<Dimension, RegExp> = {
  // ordered: match specific-first (e.g. "skin health" before "hair") — RegExps are alternations
  skin: /\bskin(?:care)?\b|\bcomplexion\b|\bwrinkle|\bfirmness\b|\bcollagen\b|\bglow\b/i,
  hair: /\bhair\b|\bnails?\b/i,
  weight: /\bweight\b|\bslim(?:mer|ming)?\b|\blose\s+(?:weight|lbs?)\b|\bdrop(?:ped)?\s+(?:weight|lbs?)\b|\bshed\b|\bpounds?\b|\blbs?\b|\bfeel\s+lighter\b|\bmetabolism\b|\bfat\b|\bpants\s+size\b|\bjeans?\s+size\b/i,
  appetite: /\bappetite\b|\bcrav(?:e|ing)/i,
  digestion: /\bdigest|\bbloat|\bgut\b|\bstomach\b|\bregular(?:ity)?\b/i,
  sleep: /\bsleep\b|\brest(?:ful)?\b|\binsomnia\b|\bmelatonin\b/i,
  focus: /\bfocus\b|\bconcentrat|\bclarity\b|\bbrain\s*fog\b|\bmental\b|\balert(?:ness)?\b/i,
  energy: /\benergy\b|\bstamina\b|\bcrash\b|\bjitter/i,
  immunity: /\bimmun(?:e|ity)\b|\bimmunit\w*\b|\bdefen[sc]e\b/i,
  mood: /\bmood\b|\bstress\b|\bcalm\b|\banxi(?:ety|ous)\b|\bhappy\b|\bhappier\b|\bpositiv(?:e|ity)\b/i,
  joint: /\bjoint\b|\bmobility\b|\bstiffness\b|\bknees?\b|\bhips?\b/i,
};

/** Classify a benefit-ish string into a coarse dimension bucket. Returns `null` when nothing
 *  in the deterministic lexicon matches — unknown text is its own bucket (no false-collapse).
 *  Pure. */
export function benefitDimensionOf(text: string): Dimension | null {
  if (!text) return null;
  for (const [dim, re] of Object.entries(DIMENSION_LEXICONS) as [Dimension, RegExp][]) {
    if (re.test(text)) return dim;
  }
  return null;
}

/**
 * Deterministic predicate — is the benefit stack DIVERSE across dimensions? Two benefits that
 * both classify as `skin` (e.g. "smooth skin" + "younger-looking skin") collapse to one
 * dimension and fail. Unknown-dimension benefits (`null` bucket) are treated as distinct — the
 * lexicon deliberately underclaims so a novel benefit is not silently duplicated.
 *
 * Rule (Part 1 § Diverse benefit stack): "Don't spend two of four beats on the same dimension."
 * Amazing Creamer's stack `[Skin Health, Hair Health, Weight Management, Digestive Health]`
 * ⇒ dims `[skin, hair, weight, digestion]` — four distinct ⇒ pass. A `[Skin Health, Skin Health,
 * Appetite Control, Digestive Health]` stack collapses skin×2 → fail.
 */
export function hasDiverseBenefitStack(benefits: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const b of benefits) {
    const dim = benefitDimensionOf(b);
    // Unknown dimensions get a stable per-text bucket so a novel benefit isn't collapsed with
    // another novel benefit; two known + same-dim benefits collide on the dim key itself.
    const key = dim ?? `unknown:${b.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Match a competitor benefit claim (e.g. "smooth wrinkles", "curb cravings") to the analogous
 * CUSTOMER-CONFIRMED benefit on OUR product. Uses two passes: (1) shared dimension via
 * `benefitDimensionOf`, then (2) substring / token overlap on the confirmed benefit name
 * + its softPhrasings. Returns `null` when no confirmed benefit is analogous — the caller
 * (Dahlia) then knows to SUBSTITUTE a different confirmed benefit rather than carry the
 * competitor's claim over unverified. Pure.
 */
export function matchConfirmedBenefit(competitorClaim: string, confirmed: readonly ConfirmedBenefit[]): ConfirmedBenefit | null {
  const claim = (competitorClaim ?? "").trim();
  if (!claim || !confirmed.length) return null;
  const claimLower = claim.toLowerCase();
  const claimDim = benefitDimensionOf(claim);

  // Pass 1 — same dimension (the strongest match). Prefers a role='lead' hit when several
  // confirmed benefits share the dim, so a lead benefit wins over a supporting one.
  if (claimDim) {
    const dimHits = confirmed.filter((b) => benefitDimensionOf(b.benefitName) === claimDim
      || b.softPhrasings.some((p) => benefitDimensionOf(p) === claimDim));
    if (dimHits.length) {
      const lead = dimHits.find((b) => b.role === "lead");
      return lead ?? dimHits[0];
    }
  }

  // Pass 2 — substring / token overlap on the confirmed benefit name or a customer phrase.
  // Catches novel-dimension matches the lexicon doesn't know (a competitor's proprietary term
  // that literally appears in one of our customer phrases).
  const claimTokens = new Set(claimLower.split(/\W+/).filter((t) => t.length >= 4));
  for (const b of confirmed) {
    const nameLower = b.benefitName.toLowerCase();
    if (nameLower.includes(claimLower) || claimLower.includes(nameLower)) return b;
    for (const p of b.softPhrasings) {
      const pLower = p.toLowerCase();
      if (pLower.includes(claimLower) || claimLower.includes(pLower)) return b;
    }
    // token overlap fallback
    const nameTokens = new Set(nameLower.split(/\W+/).filter((t) => t.length >= 4));
    for (const t of claimTokens) if (nameTokens.has(t)) return b;
  }
  return null;
}

// ── Offer-fidelity substitution ──────────────────────────────────────────────
// Part 1 § Offer fidelity — verify the competitor's CTA/offer against what we ACTUALLY offer.
// If they promise a no-payment trial ("Try Before You Buy") we don't run, SUBSTITUTE our real
// equivalent (30-day money-back guarantee → "Try It Risk-Free"). Never carry an offer we
// can't honor. The company-wide 30-day guarantee is always usable — it's a proofStack fact.
const OFFER_WE_DONT_RUN_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "try before you buy", re: /\btry\s+before\s+you\s+buy\b/i },
  { name: "free trial", re: /\bfree\s+trial\b|\btry\s+it\s+free\b/i },
  { name: "free sample", re: /\bfree\s+sample(?:s)?\b/i },
  { name: "no-payment trial", re: /\bno[\s-]?payment\s+trial\b/i },
  { name: "buy-one-get-one", re: /\b(?:bogo|buy\s+one\s+get\s+one(?:\s+free)?|buy\s+1\s+get\s+1(?:\s+free)?|get\s+(?:one|1)\s+free)\b/i },
  { name: "free tote / free gift / GWP", re: /\bfree\s+(?:tote|gift|bag)\b|\bbonus\s+(?:item|gift|pack|tote|bag)\b|\bgift\s+with\s+purchase\b|\bgwp\b|\bgiveaway\b/i },
];

/** Verbatim substitute the SKILL prefers when a competitor CTA implies something we don't run —
 *  our real, always-usable 30-day money-back guarantee framed as sanctioned "risk-free" copy. */
export const OFFER_SUBSTITUTE_RISK_FREE = "Try It Risk-Free — 30-day money-back guarantee";

export interface OfferFidelityCheck {
  needsSubstitute: boolean;
  /** Human-readable reason naming the offer we don't run (populates the SKILL's revise reason). */
  reason: string | null;
  /** The verbatim reword the SKILL should use in the CTA slot on a substitute. */
  substitute: string | null;
}

/**
 * Deterministic check — does the competitor's raw CTA imply an offer we do not run (free trial,
 * try-before-buy, free sample, no-payment trial, BOGO, freebie/GWP)? If so, `needsSubstitute=true`
 * with a `reason` naming which offer tripped it and a `substitute` string carrying our real
 * risk-free CTA. When the competitor's CTA is one we DO run (or is a plain call to action like
 * "Shop Now"), returns `{ needsSubstitute: false, ... }` unchanged. Pure.
 */
export function enforceOfferFidelity(competitorCta: string | null | undefined): OfferFidelityCheck {
  const cta = (competitorCta ?? "").trim();
  if (!cta) return { needsSubstitute: false, reason: null, substitute: null };
  for (const { name, re } of OFFER_WE_DONT_RUN_PATTERNS) {
    if (re.test(cta)) {
      return {
        needsSubstitute: true,
        reason: `competitor CTA implies ${name} — we do not run this; substitute our real risk-free 30-day money-back guarantee`,
        substitute: OFFER_SUBSTITUTE_RISK_FREE,
      };
    }
  }
  return { needsSubstitute: false, reason: null, substitute: null };
}
