/**
 * angle-palette — the SDK chokepoint for a product's clean, curated angle palette
 * (`public.product_angle_palette`). This is the v3 fan-out: Product → Ingredient → Theme →
 * Problem-Angle, each row carrying the raw parts a headline needs (enemy / mechanism / proof /
 * outcome) + the demand signal (the SELECTOR) + the evidence tier (a proof STYLE, never a filter)
 * + coverage (times_used / last_used_at / status).
 *
 * Demand selects the angle; scientific evidence reinforces it (marketing tools, CEO 2026-07-21).
 * Angles are keyed on PROBLEM, not ingredient — one ingredient fans across many problem-lanes.
 *
 * All reads/writes go through here (never raw `.from('product_angle_palette')`). Populated once
 * per hero product by a `_seed-angle-palette-*.ts` script, then extended by Dahlia's fan-out when a
 * theme runs low on fresh combinations. See docs/brain/libraries/angle-palette.md,
 * docs/brain/tables/product_angle_palette.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AwarenessStage } from "./headline-patterns";

type Admin = SupabaseClient;

/** The top-level positioning menu = coverage axis + audience tag. */
export type AngleTheme =
  | "beauty"
  | "longevity"
  | "healthy_weight"
  | "energy_performance"
  | "focus"
  | "gut";

export type EvidenceTier = "science_strong" | "science_modest" | "customer_only";
export type SearchDemand = "high" | "medium" | "low";
export type AngleSource = "seeded" | "dahlia_fanned" | "competitor_mapped";
export type AngleStatus = "fresh" | "testing" | "crowned" | "retired";

export interface ProductAngle {
  id: string;
  productId: string;
  theme: AngleTheme;
  problem: string;
  ingredients: string[];
  benefitKey: string | null;
  enemy: string | null;
  mechanism: string | null;
  desiredOutcome: string | null;
  proofText: string | null;
  proofKind: string | null;
  evidenceTier: EvidenceTier;
  backingReviewIds: string[];
  searchDemand: SearchDemand;
  awarenessStages: AwarenessStage[];
  source: AngleSource;
  timesUsed: number;
  lastUsedAt: string | null;
  status: AngleStatus;
  isActive: boolean;
  displayOrder: number;
  notes: string | null;
}

interface AngleRow {
  id: string;
  product_id: string;
  theme: string;
  problem: string;
  ingredients: string[] | null;
  benefit_key: string | null;
  enemy: string | null;
  mechanism: string | null;
  desired_outcome: string | null;
  proof_text: string | null;
  proof_kind: string | null;
  evidence_tier: string;
  backing_review_ids: string[] | null;
  search_demand: string;
  awareness_stages: string[] | null;
  source: string;
  times_used: number;
  last_used_at: string | null;
  status: string;
  is_active: boolean;
  display_order: number;
  notes: string | null;
}

function toAngle(r: AngleRow): ProductAngle {
  return {
    id: r.id,
    productId: r.product_id,
    theme: r.theme as AngleTheme,
    problem: r.problem,
    ingredients: r.ingredients ?? [],
    benefitKey: r.benefit_key,
    enemy: r.enemy,
    mechanism: r.mechanism,
    desiredOutcome: r.desired_outcome,
    proofText: r.proof_text,
    proofKind: r.proof_kind,
    evidenceTier: r.evidence_tier as EvidenceTier,
    backingReviewIds: r.backing_review_ids ?? [],
    searchDemand: r.search_demand as SearchDemand,
    awarenessStages: (r.awareness_stages ?? []) as AwarenessStage[],
    source: r.source as AngleSource,
    timesUsed: r.times_used,
    lastUsedAt: r.last_used_at,
    status: r.status as AngleStatus,
    isActive: r.is_active,
    displayOrder: r.display_order,
    notes: r.notes,
  };
}

/** The shape a seed/fan-out author writes. Coverage fields default server-side. */
export interface AnglePaletteInput {
  theme: AngleTheme;
  problem: string;
  ingredients: string[];
  benefitKey?: string | null;
  enemy?: string | null;
  mechanism?: string | null;
  desiredOutcome?: string | null;
  proofText?: string | null;
  proofKind?: string | null;
  evidenceTier: EvidenceTier;
  backingReviewIds?: string[];
  searchDemand: SearchDemand;
  awarenessStages?: AwarenessStage[];
  source?: AngleSource;
  displayOrder?: number;
  notes?: string | null;
}

/** List a product's palette, optionally filtered by theme / status / awareness stage. */
export async function listAnglePalette(
  admin: Admin,
  workspaceId: string,
  productId: string,
  opts?: { theme?: AngleTheme; status?: AngleStatus; awarenessStage?: AwarenessStage; includeInactive?: boolean },
): Promise<ProductAngle[]> {
  let q = admin
    .from("product_angle_palette")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("display_order", { ascending: true });
  if (!opts?.includeInactive) q = q.eq("is_active", true);
  if (opts?.theme) q = q.eq("theme", opts.theme);
  if (opts?.status) q = q.eq("status", opts.status);
  const { data, error } = await q;
  if (error) throw error;
  let rows = (data ?? []).map((r) => toAngle(r as AngleRow));
  if (opts?.awarenessStage) {
    rows = rows.filter((a) => a.awarenessStages.includes(opts.awarenessStage!));
  }
  return rows;
}

/** The distinct themes present in a product's active palette (coverage axis for selection). */
export async function listPaletteThemes(
  admin: Admin,
  workspaceId: string,
  productId: string,
): Promise<AngleTheme[]> {
  const rows = await listAnglePalette(admin, workspaceId, productId);
  return [...new Set(rows.map((r) => r.theme))];
}

/** Idempotently upsert one angle (unique on workspace+product+theme+problem). Returns its id. */
export async function upsertAngle(
  admin: Admin,
  workspaceId: string,
  productId: string,
  input: AnglePaletteInput,
): Promise<string> {
  const row = {
    workspace_id: workspaceId,
    product_id: productId,
    theme: input.theme,
    problem: input.problem,
    ingredients: input.ingredients,
    benefit_key: input.benefitKey ?? null,
    enemy: input.enemy ?? null,
    mechanism: input.mechanism ?? null,
    desired_outcome: input.desiredOutcome ?? null,
    proof_text: input.proofText ?? null,
    proof_kind: input.proofKind ?? null,
    evidence_tier: input.evidenceTier,
    backing_review_ids: input.backingReviewIds ?? [],
    search_demand: input.searchDemand,
    awareness_stages: input.awarenessStages ?? ["cold", "warm", "hot"],
    source: input.source ?? "seeded",
    display_order: input.displayOrder ?? 0,
    notes: input.notes ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await admin
    .from("product_angle_palette")
    .upsert(row, { onConflict: "workspace_id,product_id,theme,problem" })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** Bump an angle's coverage on use (times_used + last_used_at). */
export async function markAngleUsed(admin: Admin, angleId: string, atIso: string): Promise<void> {
  const { data } = await admin
    .from("product_angle_palette")
    .select("times_used")
    .eq("id", angleId)
    .maybeSingle();
  const next = ((data as { times_used?: number } | null)?.times_used ?? 0) + 1;
  const { error } = await admin
    .from("product_angle_palette")
    .update({ times_used: next, last_used_at: atIso, updated_at: atIso })
    .eq("id", angleId);
  if (error) throw error;
}

/** Set an angle's lifecycle status (fresh → testing → crowned/retired). */
export async function setAngleStatus(admin: Admin, angleId: string, status: AngleStatus): Promise<void> {
  const { error } = await admin
    .from("product_angle_palette")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", angleId);
  if (error) throw error;
}
