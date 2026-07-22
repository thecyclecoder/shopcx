/**
 * selection-engine — the v3 portfolio selector for Dahlia's next (angle × pattern) shot.
 *
 * Phase 1 (this file) installs the two READERS the selector's rail is built on:
 *   • `listEligibleCombinations({admin, workspaceId, productId, temperature})` — the fresh,
 *     cooldown-eligible combinations for a product, joined against the palette (via the
 *     [[angle-palette]] SDK) and the temperature-legal, consumes-fillable patterns (via
 *     the [[headline-patterns]] SDK). One deterministic view of "what can we ship right now?"
 *   • `readLiveBinThemeDistribution({admin, workspaceId, productId})` — the live map from
 *     theme → count of `status='ready'` [[../../docs/brain/tables/ad_campaigns.md]] rows,
 *     the quota the theme-spread rail measures against.
 *
 * These readers are the single source of truth for the ledger; the Phase-2 picker
 * (`pickNextCombination`) layers the rail + loser filter + 70/30 explore/exploit on top.
 *
 * All coverage bumps + combination upserts stay in [[creative-combinations]]; this module
 * is read-only. All palette/pattern reads route through their existing SDK chokepoints —
 * never raw `.from('product_angle_palette')` or `.from('ad_headline_patterns')` here.
 *
 * See docs/brain/specs/selection-engine-coverage-ledger.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { listAnglePalette, type AngleTheme, type ProductAngle } from "./angle-palette";
import {
  listHeadlinePatterns,
  type AnglePart,
  type AwarenessStage,
  type HeadlinePattern,
} from "./headline-patterns";
import {
  listCombinationsForProduct,
  type CreativeCombination,
} from "./creative-combinations";

type Admin = SupabaseClient;

/** Per-combination cooldown horizon in days — the freshness grain the goal spec names.
 *  Named-export so the Phase-2 picker (and any future tuner) can move it in one place. */
export const COOLDOWN_DAYS = 45;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One eligible shot for the picker: a combination + the palette angle + the legal pattern
 *  + the angle's theme (the quota axis). All four fields are always present — an eligible
 *  row that cannot be joined against a fresh angle / legal pattern is filtered OUT upstream. */
export interface EligibleShot {
  combination: CreativeCombination;
  angle: ProductAngle;
  pattern: HeadlinePattern;
  theme: AngleTheme;
}

/**
 * Which angle-parts the given palette row can fill from its own columns. `subject` +
 * `product` come from the workspace/SKU (not the angle) so they're always populated.
 * Mirrors [[select-angle-pattern]] `partsPopulatedByAngle` — a pattern's `consumes` list
 * must be fillable by this set (offer/guarantee gated on temperature, not angle).
 */
function partsPopulatedByAngle(angle: ProductAngle): Set<AnglePart> {
  const parts = new Set<AnglePart>();
  parts.add("subject");
  parts.add("product");
  if (angle.enemy) parts.add("enemy");
  if (angle.mechanism) parts.add("mechanism");
  if (angle.desiredOutcome) parts.add("outcome");
  if (angle.proofText) parts.add("proof");
  if ((angle.backingReviewIds ?? []).length > 0) parts.add("review");
  return parts;
}

/** True when the pattern's `consumes` list is fillable by the angle's populated parts
 *  under the current temperature. `offer` + `guarantee` are workspace-context and are
 *  legal only when temperature is not 'cold' (mirrors [[select-angle-pattern]] and
 *  [[compose-headline]] — cold ads carry no offer). */
export function patternFillableByAngle(
  pattern: HeadlinePattern,
  angle: ProductAngle,
  temperature: AwarenessStage,
): boolean {
  const populated = partsPopulatedByAngle(angle);
  const offerAvailable = temperature !== "cold";
  for (const need of pattern.consumes) {
    if (need === "offer" || need === "guarantee") {
      if (!offerAvailable) return false;
      continue;
    }
    if (!populated.has(need)) return false;
  }
  return true;
}

/** True when the combination's `last_used_at` is `null` (never shipped) or older than
 *  the `COOLDOWN_DAYS` horizon at `nowIso`. Exported so Phase-2 tests + tuners can share
 *  the same predicate rather than re-encoding the horizon at each call site. */
export function isPastCooldown(
  lastUsedAt: string | null,
  nowIso: string = new Date().toISOString(),
): boolean {
  if (!lastUsedAt) return true;
  const lastMs = Date.parse(lastUsedAt);
  if (Number.isNaN(lastMs)) return true;
  const nowMs = Date.parse(nowIso);
  const ageMs = nowMs - lastMs;
  return ageMs >= COOLDOWN_DAYS * MS_PER_DAY;
}

export interface LedgerReadArgs {
  admin: Admin;
  workspaceId: string;
  productId: string;
  temperature: AwarenessStage;
  /** Override for tests / deterministic seeding — defaults to `new Date().toISOString()`. */
  nowIso?: string;
}

/**
 * Return the (combination × angle × pattern × theme) tuples eligible to ship right now:
 *   • combination.status === 'fresh' AND its `last_used_at` is past the ~45-day cooldown
 *   • angle is `status='fresh'` + `is_active=true` + serves this temperature
 *     (all filters routed through [[angle-palette]] `listAnglePalette`)
 *   • pattern is legal for this temperature AND its `consumes` list is fillable by the
 *     angle's populated parts (routed through [[headline-patterns]] `listHeadlinePatterns`)
 *
 * A combination whose angle or pattern was retired / made inactive / drops out of the
 * temperature filter is silently dropped — the ledger row is memory of a past shot, not a
 * guarantee it's still viable. The picker never starves silently — returning `[]` here
 * lets Phase-2 return `null` so the caller can escalate.
 */
export async function listEligibleCombinations(
  args: LedgerReadArgs,
): Promise<EligibleShot[]> {
  const nowIso = args.nowIso ?? new Date().toISOString();

  const [angles, patterns, combos] = await Promise.all([
    listAnglePalette(args.admin, args.workspaceId, args.productId, {
      status: "fresh",
      awarenessStage: args.temperature,
    }),
    listHeadlinePatterns(args.admin, args.workspaceId, {
      awarenessStage: args.temperature,
    }),
    listCombinationsForProduct(args.admin, {
      workspaceId: args.workspaceId,
      productId: args.productId,
      status: "fresh",
    }),
  ]);

  if (angles.length === 0 || patterns.length === 0 || combos.length === 0) return [];

  const angleById = new Map(angles.map((a) => [a.id, a]));
  const patternById = new Map(patterns.map((p) => [p.id, p]));

  const eligible: EligibleShot[] = [];
  for (const combo of combos) {
    if (!isPastCooldown(combo.lastUsedAt, nowIso)) continue;
    const angle = angleById.get(combo.angleId);
    if (!angle) continue;
    const pattern = patternById.get(combo.patternId);
    if (!pattern) continue;
    if (!patternFillableByAngle(pattern, angle, args.temperature)) continue;
    eligible.push({ combination: combo, angle, pattern, theme: angle.theme });
  }
  return eligible;
}

export interface ThemeDistributionArgs {
  admin: Admin;
  workspaceId: string;
  productId: string;
}

/**
 * Live-bin theme distribution: a map from `creative_theme` → count of `ad_campaigns` rows
 * with `status='ready'` for this (workspace, product). Reads the `creative_theme` stamp
 * populated by the wire-engine spec's Phase 3 `insertReadyCreative`. Rows with a NULL
 * stamp are counted under a separate `null` key so the caller can see coverage gaps —
 * unstamped rows are legacy / pre-M1 and don't count against theme quotas.
 *
 * Reads `ad_campaigns` directly here (not via ads-read-sdk) because ads-read-sdk's row
 * shape is per-ad; the selector needs an aggregate count. Kept minimal + typed so a
 * later chokepoint move is a rename, not a rewrite.
 */
export async function readLiveBinThemeDistribution(
  args: ThemeDistributionArgs,
): Promise<Map<AngleTheme | null, number>> {
  const { data, error } = await args.admin
    .from("ad_campaigns")
    .select("creative_theme")
    .eq("workspace_id", args.workspaceId)
    .eq("product_id", args.productId)
    .eq("status", "ready");
  if (error) throw error;
  const rows = (data ?? []) as Array<{ creative_theme: string | null }>;
  const dist = new Map<AngleTheme | null, number>();
  for (const r of rows) {
    const key = (r.creative_theme as AngleTheme | null) ?? null;
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }
  return dist;
}
