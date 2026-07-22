/**
 * decision-engine — the v3 substitution engine: turn a chosen (angle × pattern × temperature ×
 * skeleton × product) into a temperature-honest, product-faithful set of substituted wireframe
 * elements the copy author + Max grade against.
 *
 * The v3 goal recasts the decision engine as **function-preserving substitution, temperature-keyed**:
 *   • cold      → strip the offer/price slot; substitute value / proof / risk-reversal from the angle
 *   • warm/hot  → fill the offer slot with our REAL offer (productIntelligence.offer.headline) VERBATIM
 *
 * Stateless, deterministic, no admin client, no DB reads, no LLM. Same inputs → same outputs so
 * Max's substitution supervisor rubric (Phase 2) has a stable target.
 *
 * See docs/brain/specs/decision-engine-substitution-supervisor.md · Phase 1.
 */
import { computeReuseVerdict, type ReuseVerdict } from "@/lib/creative-skeleton-reuse";
import type { ProductAngle } from "@/lib/ads/angle-palette";
import type { HeadlinePattern, AwarenessStage } from "@/lib/ads/headline-patterns";
import type { ProductOffer } from "@/lib/product-intelligence";

// ── Shapes ─────────────────────────────────────────────────────────────────────

/** One wireframe element — mirrors the shape gated by `creative_skeletons_elements_shape_chk`. */
export interface SkeletonElement {
  zone: "header" | "hero" | "body" | "footer" | "cta";
  role: "hook" | "mechanism" | "proof" | "offer" | "risk_reversal" | "social_proof" | "price";
  prominence: number;
}

/** The subset of a `creative_skeletons` row the decision engine needs. Callers (Phase 3
 *  wire-in) construct this from the DB row: `elements` from `elements` jsonb, `raw` from
 *  the four legacy substance columns, `advertiser` from `advertiser`. */
export interface SkeletonForDecision {
  elements: SkeletonElement[];
  /** The competitor's raw substance strings from the analyzed source — the noLeak guard
   *  refuses any substituted text that contains one of these substrings. Contributions:
   *  every non-null value from `hook`, `mechanism_claim`, `proof`, `offer`. */
  raw: string[];
  /** The competitor's advertiser name (`creative_skeletons.advertiser`). noLeak refuses it. */
  advertiser: string | null;
}

/** Passthrough for audit — the engine never reads product fields, but keeps the reference
 *  in scope so downstream (Max's rubric) can render provenance without another lookup. */
export interface ProductForDecision {
  id?: string | null;
  name?: string | null;
}

/** The narrow view of product intelligence the engine consults for warm/hot offer fills. */
export interface DecisionEngineIntelligence {
  offer: ProductOffer | null;
}

export interface SubstituteInput {
  angle: ProductAngle;
  pattern: HeadlinePattern;
  temperature: AwarenessStage;
  /** May be null for products/temperatures that ship without a competitor skeleton;
   *  the engine returns an empty substitutedElements + noEmptySlot=true (vacuously). */
  skeleton: SkeletonForDecision | null;
  product?: ProductForDecision | null;
}

/** The provenance tag Max audits per substituted element. */
export type SubstitutionSource =
  | "angle_direct"
  | "angle_derived_risk_reversal"
  | "product_intelligence.offer"
  | "stripped";

export interface SubstitutedElement {
  zone: SkeletonElement["zone"];
  role: SkeletonElement["role"];
  prominence: number;
  /** null iff role was stripped (cold + offer/price with no substitute available). */
  substitutedText: string | null;
  reuseVerdict: ReuseVerdict;
  source: SubstitutionSource;
}

export interface SubstitutionGuardrails {
  /** Every element has a non-empty substitutedText. */
  noEmptySlot: boolean;
  /** Every offer/price element sources from productIntelligence when temperature ∈ warm/hot,
   *  OR is explicitly stripped when cold. A warm/hot offer with a null PI.offer fails. */
  honestFill: boolean;
  /** No substitutedText contains any competitor raw string or the competitor's advertiser name
   *  (case-insensitive substring match). */
  noLeak: boolean;
  /** Across all substituted texts, at least one references angle.problem or angle.mechanism
   *  (case-insensitive substring). */
  onStrategy: boolean;
}

export interface SubstitutionResult {
  substitutedElements: SubstitutedElement[];
  guardrails: SubstitutionGuardrails;
}

// ── Substitution rule table — the single source the M4 tuning + audit reads ──

/** The named substitution-rule table. Each row is one (temperature, role) → action + source.
 *  A row with role='*' catches any other role at that temperature. Order matters: the first
 *  matching row wins. Exported so tuning (M4) and audit read one authoritative table. */
export const SUBSTITUTION_RULES = [
  {
    temperature: "cold" as AwarenessStage,
    role: "offer" as SkeletonElement["role"] | "*",
    action: "strip_and_substitute_risk_reversal" as const,
    source: "angle_derived_risk_reversal" as SubstitutionSource,
  },
  {
    temperature: "cold" as AwarenessStage,
    role: "price" as SkeletonElement["role"] | "*",
    action: "strip_and_substitute_value" as const,
    source: "angle_derived_risk_reversal" as SubstitutionSource,
  },
  {
    temperature: "warm" as AwarenessStage,
    role: "offer" as SkeletonElement["role"] | "*",
    action: "fill_from_product_intelligence" as const,
    source: "product_intelligence.offer" as SubstitutionSource,
  },
  {
    temperature: "hot" as AwarenessStage,
    role: "offer" as SkeletonElement["role"] | "*",
    action: "fill_from_product_intelligence" as const,
    source: "product_intelligence.offer" as SubstitutionSource,
  },
] as const;

// ── The engine ─────────────────────────────────────────────────────────────────

/** Turn a chosen (angle, pattern, temperature, skeleton, product) into a temperature-honest,
 *  product-faithful set of substituted wireframe elements + a four-axis guardrails object.
 *
 *  Stateless. Never touches the DB. Never invents an offer (warm/hot with no PI.offer flunks
 *  honestFill and returns the element with source='product_intelligence.offer' + substitutedText=null,
 *  never a fabricated string). */
export function substituteIntoSkeleton(
  input: SubstituteInput,
  ctx: { productIntelligence: DecisionEngineIntelligence },
): SubstitutionResult {
  const elements: SkeletonElement[] = input.skeleton?.elements ?? [];
  const substitutedElements: SubstitutedElement[] = elements.map((el) => substituteElement(el, input, ctx));
  const guardrails = computeGuardrails(substitutedElements, input, ctx);
  return { substitutedElements, guardrails };
}

function substituteElement(
  el: SkeletonElement,
  input: SubstituteInput,
  ctx: { productIntelligence: DecisionEngineIntelligence },
): SubstitutedElement {
  const reuseVerdict = computeReuseVerdict(el, { temperature: input.temperature });
  const { angle, temperature } = input;
  const piOffer = ctx.productIntelligence.offer;

  // Rule 1 + 2 — cold + offer|price → strip the promo slot and substitute a value / risk-reversal.
  if (temperature === "cold" && (el.role === "offer" || el.role === "price")) {
    const substituted = deriveRiskReversal(angle);
    return {
      zone: el.zone,
      role: el.role,
      prominence: el.prominence,
      substitutedText: substituted,
      reuseVerdict,
      source: substituted ? "angle_derived_risk_reversal" : "stripped",
    };
  }

  // Rule 3 + 4 — warm/hot + offer → fill from productIntelligence.offer VERBATIM (never invent).
  if ((temperature === "warm" || temperature === "hot") && el.role === "offer") {
    return {
      zone: el.zone,
      role: el.role,
      prominence: el.prominence,
      substitutedText: piOffer ? piOffer.headline : null,
      reuseVerdict,
      source: "product_intelligence.offer",
    };
  }

  // Default — fill from the angle's raw parts per role.
  const text = deriveFromAngle(el.role, angle);
  return {
    zone: el.zone,
    role: el.role,
    prominence: el.prominence,
    substitutedText: text,
    reuseVerdict,
    source: "angle_direct",
  };
}

function deriveRiskReversal(angle: ProductAngle): string | null {
  return firstNonEmpty([angle.proofText, angle.desiredOutcome]);
}

function deriveFromAngle(role: SkeletonElement["role"], angle: ProductAngle): string | null {
  switch (role) {
    case "hook":
      return firstNonEmpty([angle.enemy, angle.problem]);
    case "mechanism":
      return angle.mechanism ?? null;
    case "proof":
      return angle.proofText ?? null;
    case "risk_reversal":
      return firstNonEmpty([angle.desiredOutcome, angle.proofText]);
    case "social_proof":
      return firstNonEmpty([angle.proofText, angle.desiredOutcome]);
    // A price element on warm/hot without an angle-level price story falls back to
    // productIntelligence — but that path is only hit if the caller sets role='price'
    // for warm/hot. To keep the engine stateless we substitute from the angle here and
    // let the guardrails carry the honesty check.
    case "offer":
    case "price":
      return firstNonEmpty([angle.desiredOutcome, angle.proofText]);
  }
}

function firstNonEmpty(vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function computeGuardrails(
  substituted: SubstitutedElement[],
  input: SubstituteInput,
  ctx: { productIntelligence: DecisionEngineIntelligence },
): SubstitutionGuardrails {
  const noEmptySlot = substituted.every((e) => typeof e.substitutedText === "string" && e.substitutedText.length > 0);

  const honestFill = substituted.every((e) => {
    if (e.role !== "offer" && e.role !== "price") return true;
    if (input.temperature === "cold") {
      // cold + offer/price must be stripped (source is derived risk-reversal or a bare 'stripped')
      return e.source === "angle_derived_risk_reversal" || e.source === "stripped";
    }
    // warm/hot: offer must source from PI, AND PI must have provided a headline (not null).
    if (e.role === "offer") {
      return e.source === "product_intelligence.offer" && typeof e.substitutedText === "string" && e.substitutedText.length > 0;
    }
    // warm/hot + price element: honesty means PI.offer exists (we never invent a price string).
    return ctx.productIntelligence.offer !== null;
  });

  const rawNeedles: string[] = [];
  const raw = input.skeleton?.raw ?? [];
  for (const s of raw) if (typeof s === "string" && s.trim().length > 0) rawNeedles.push(s.toLowerCase());
  const advertiser = input.skeleton?.advertiser ?? null;
  if (advertiser && advertiser.trim().length > 0) rawNeedles.push(advertiser.toLowerCase());
  const noLeak = substituted.every((e) => {
    if (!e.substitutedText) return true;
    const hay = e.substitutedText.toLowerCase();
    return rawNeedles.every((needle) => !hay.includes(needle));
  });

  const problem = (input.angle.problem ?? "").toLowerCase().trim();
  const mechanism = (input.angle.mechanism ?? "").toLowerCase().trim();
  const onStrategy = substituted.some((e) => {
    if (!e.substitutedText) return false;
    const hay = e.substitutedText.toLowerCase();
    if (problem.length > 0 && hay.includes(problem)) return true;
    if (mechanism.length > 0 && hay.includes(mechanism)) return true;
    return false;
  });

  return { noEmptySlot, honestFill, noLeak, onStrategy };
}
