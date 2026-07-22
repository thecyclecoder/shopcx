/**
 * headline-patterns — the SDK chokepoint for the SHARED, product-agnostic headline-pattern library
 * (`public.ad_headline_patterns`). ~13 reusable direct-response formulas keyed by awareness stage.
 *
 * The v3 creative engine composes a headline as **Angle × Pattern**: the angle (from
 * [[./angle-palette]]) supplies the raw parts (enemy / mechanism / proof / outcome), the pattern
 * supplies the STRUCTURE, and the awareness stage (temperature) gates which patterns are legal.
 * The 5 caption variations = 5 patterns on ONE angle.
 *
 * Patterns are NOT verbatim templates — they're the grounded north-star structure Dahlia flexes
 * toward a competitor's punchiness. `consumes` declares which angle-parts a pattern needs so the
 * selector never picks a pattern the chosen angle can't fill.
 *
 * All writes go through here (never raw `.from('ad_headline_patterns')`). See
 * docs/brain/libraries/headline-patterns.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export type AwarenessStage = "cold" | "warm" | "hot";

/** An angle-part a pattern can consume when it fills its structure. */
export type AnglePart =
  | "subject"
  | "enemy"
  | "mechanism"
  | "proof"
  | "outcome"
  | "product"
  | "review"
  | "offer"
  | "guarantee";

export interface HeadlinePattern {
  id: string;
  slug: string;
  name: string;
  /** The formula, with [BRACKETED] slots the author fills from the angle. */
  structure: string;
  awarenessStages: AwarenessStage[];
  consumes: AnglePart[];
  example: string | null;
  isActive: boolean;
  displayOrder: number;
}

interface PatternRow {
  id: string;
  slug: string;
  name: string;
  structure: string;
  awareness_stages: string[] | null;
  consumes: string[] | null;
  example: string | null;
  is_active: boolean;
  display_order: number;
}

function toPattern(r: PatternRow): HeadlinePattern {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    structure: r.structure,
    awarenessStages: (r.awareness_stages ?? []) as AwarenessStage[],
    consumes: (r.consumes ?? []) as AnglePart[],
    example: r.example,
    isActive: r.is_active,
    displayOrder: r.display_order,
  };
}

/**
 * The canonical seed library (~13 formulas). Shared across ALL products — a pattern is a structure,
 * not a claim, so it's product-agnostic. `seedHeadlinePatterns` upserts these idempotently.
 */
export const HEADLINE_PATTERN_SEED: ReadonlyArray<
  Omit<HeadlinePattern, "id"> & { slug: string }
> = [
  // ── ❄️ COLD — intrigue / reframe / NO offer ────────────────────────────────
  {
    slug: "reframe",
    name: "Reframe (not-X-but-Y)",
    structure: "[SUBJECT] doesn't need more [ENEMY]. It needs [MECHANISM].",
    awarenessStages: ["cold"],
    consumes: ["subject", "enemy", "mechanism"],
    example: "Your skin doesn't need more serums. It needs collagen.",
    isActive: true,
    displayOrder: 1,
  },
  {
    slug: "curiosity-gap",
    name: "Curiosity gap",
    structure: "Why your [ENEMY] [secretly fails / stops short].",
    awarenessStages: ["cold"],
    consumes: ["enemy", "mechanism"],
    example: "Why your $80 serum stops at the surface.",
    isActive: true,
    displayOrder: 2,
  },
  {
    slug: "villain-callout",
    name: "Villain call-out",
    structure: "[INDUSTRY/ENEMY] hopes you never hear about [MECHANISM].",
    awarenessStages: ["cold"],
    consumes: ["enemy", "mechanism"],
    example: "The skincare aisle hopes you never hear the word collagen.",
    isActive: true,
    displayOrder: 3,
  },
  {
    slug: "mechanism-reveal",
    name: "Mechanism reveal",
    structure: "[OUTCOME] happens from [unexpected place] — that's [MECHANISM].",
    awarenessStages: ["cold"],
    consumes: ["mechanism", "outcome"],
    example: "Real skin repair happens from the inside — that's collagen.",
    isActive: true,
    displayOrder: 4,
  },
  {
    slug: "problem-agitate",
    name: "Problem-agitate",
    structure: "[VIVID SYMPTOM]? It's not [assumed cause], it's [MECHANISM/real cause].",
    awarenessStages: ["cold"],
    consumes: ["outcome", "mechanism"],
    example: "Brittle nails? It's not your polish, it's missing collagen.",
    isActive: true,
    displayOrder: 5,
  },
  {
    slug: "story",
    name: "Story / first-person",
    structure: "I [did X for one reason]. [Surprise OUTCOME] was the surprise.",
    awarenessStages: ["cold"],
    consumes: ["outcome", "product"],
    example: "I bought it for my coffee. My skin was the surprise.",
    isActive: true,
    displayOrder: 6,
  },
  {
    slug: "question",
    name: "Question hook",
    structure: "What if your [daily habit / PRODUCT] also [OUTCOME]?",
    awarenessStages: ["cold"],
    consumes: ["outcome", "product"],
    example: "What if your morning coffee also fed your skin?",
    isActive: true,
    displayOrder: 7,
  },
  // ── 🌤️ WARM — proof / comparison / specificity ────────────────────────────
  {
    slug: "social-proof",
    name: "Social proof",
    structure: "[N] people quietly [switched / swear by it].",
    awarenessStages: ["warm", "hot"],
    consumes: ["proof", "outcome"],
    example: "700,000+ traded their serum for this creamer.",
    isActive: true,
    displayOrder: 8,
  },
  {
    slug: "specificity",
    name: "Specificity / reason-why",
    structure: "[MECHANISM/ingredients], [spec], [OUTCOME].",
    awarenessStages: ["warm", "hot"],
    consumes: ["mechanism", "proof"],
    example: "Collagen + hyaluronic acid, one scoop, younger-looking skin.",
    isActive: true,
    displayOrder: 9,
  },
  {
    slug: "comparison",
    name: "Comparison / vs",
    structure: "[OURS] vs [ENEMY]: [the real difference].",
    awarenessStages: ["warm", "hot"],
    consumes: ["enemy", "mechanism"],
    example: "Collagen you drink vs collagen you dab on: one actually absorbs.",
    isActive: true,
    displayOrder: 10,
  },
  {
    slug: "testimonial",
    name: "Testimonial-led",
    structure: "“[verbatim REVIEW].”",
    awarenessStages: ["warm", "hot"],
    consumes: ["review"],
    example: "“My nails and hair have never grown so fast.”",
    isActive: true,
    displayOrder: 11,
  },
  // ── 🔥 HOT — offer / urgency / risk-reversal ───────────────────────────────
  {
    slug: "risk-reversal",
    name: "Risk reversal",
    structure: "[OUTCOME] in [timeframe], or your money back.",
    awarenessStages: ["warm", "hot"],
    consumes: ["outcome", "guarantee"],
    example: "Smoother skin in 30 days, or your money back.",
    isActive: true,
    displayOrder: 12,
  },
  {
    slug: "offer",
    name: "Offer",
    structure: "[OFFER] on the [PRODUCT] that [OUTCOME].",
    awarenessStages: ["hot"],
    consumes: ["offer", "product", "outcome"],
    example: "34% off + free shipping on the creamer that feeds your skin.",
    isActive: true,
    displayOrder: 13,
  },
];

/** List active patterns for a workspace, optionally filtered to an awareness stage. */
export async function listHeadlinePatterns(
  admin: Admin,
  workspaceId: string,
  opts?: { awarenessStage?: AwarenessStage; includeInactive?: boolean },
): Promise<HeadlinePattern[]> {
  let q = admin
    .from("ad_headline_patterns")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("display_order", { ascending: true });
  if (!opts?.includeInactive) q = q.eq("is_active", true);
  const { data, error } = await q;
  if (error) throw error;
  let rows = (data ?? []).map((r) => toPattern(r as PatternRow));
  if (opts?.awarenessStage) {
    rows = rows.filter((p) => p.awarenessStages.includes(opts.awarenessStage!));
  }
  return rows;
}

/** Get one pattern by slug. */
export async function getHeadlinePattern(
  admin: Admin,
  workspaceId: string,
  slug: string,
): Promise<HeadlinePattern | null> {
  const { data, error } = await admin
    .from("ad_headline_patterns")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data ? toPattern(data as PatternRow) : null;
}

/** Idempotently upsert the canonical seed library for a workspace. Returns the count written. */
export async function seedHeadlinePatterns(admin: Admin, workspaceId: string): Promise<number> {
  const rows = HEADLINE_PATTERN_SEED.map((p) => ({
    workspace_id: workspaceId,
    slug: p.slug,
    name: p.name,
    structure: p.structure,
    awareness_stages: p.awarenessStages,
    consumes: p.consumes,
    example: p.example,
    is_active: p.isActive,
    display_order: p.displayOrder,
  }));
  const { error } = await admin
    .from("ad_headline_patterns")
    .upsert(rows, { onConflict: "workspace_id,slug" });
  if (error) throw error;
  return rows.length;
}
