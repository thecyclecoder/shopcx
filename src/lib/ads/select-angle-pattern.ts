/**
 * select-angle-pattern — the ONE call site the author path uses to pick the next
 * (angle, pattern) to compose. Given (workspaceId, productId, temperature) it reads:
 *
 *   • the product's live palette through [[./angle-palette]] listAnglePalette
 *     (status:'fresh', awarenessStage:temperature — the M1 SDK owns the filter)
 *   • the shared, temperature-legal patterns through [[./headline-patterns]]
 *     listHeadlinePatterns (awarenessStage:temperature)
 *
 * It picks the first fresh angle × first legal pattern (a pattern whose `consumes`
 * list is filled by the angle's populated parts, respecting the temperature-keyed
 * offer rule — cold ads carry no offer). Returns the pair + theme so the caller can
 * persist the {creative_theme, angle_palette_id, headline_pattern_id, combination_id}
 * stamps and bump coverage.
 *
 * On empty palette or no legal pattern, returns null — the author session falls
 * back to the pre-M1 inlined path so no product regresses. NEVER throws (Dahlia
 * must not stall on a picker miss).
 *
 * Phase-1 heuristic is intentionally simple (first-fresh × first-legal). The
 * coverage-ledger + freshness cooldown work later replaces the heuristic in-place
 * without changing this call site. See docs/brain/specs/wire-engine-into-dahlia-author-path.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { listAnglePalette, type ProductAngle, type AngleTheme } from "./angle-palette";
import {
  listHeadlinePatterns,
  type AnglePart,
  type AwarenessStage,
  type HeadlinePattern,
} from "./headline-patterns";

type Admin = SupabaseClient;

export interface SelectedAnglePattern {
  angle: ProductAngle;
  pattern: HeadlinePattern;
  theme: AngleTheme;
}

/**
 * The angle-parts a given palette row can fill from its own columns. `subject` +
 * `product` are always available (they come from the workspace/SKU, not the angle).
 * `offer` + `guarantee` are workspace-context, not angle-context, and are gated by
 * temperature in `patternIsLegalForAngle` (cold ads carry no offer).
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

/**
 * A pattern is legal for an angle when every part it consumes is either populated
 * on the angle or available from workspace context under the current temperature.
 * The temperature-keyed offer rule (cold → no offer, warm/hot → offer available)
 * mirrors compose-headline's policy — a cold pattern must never reach for `offer`.
 */
export function patternIsLegalForAngle(
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

export interface SelectAnglePatternArgs {
  admin: Admin;
  workspaceId: string;
  productId: string;
  temperature: AwarenessStage;
}

export async function selectAnglePatternForBrief(
  args: SelectAnglePatternArgs,
): Promise<SelectedAnglePattern | null> {
  const angles = await listAnglePalette(args.admin, args.workspaceId, args.productId, {
    status: "fresh",
    awarenessStage: args.temperature,
  });
  if (angles.length === 0) return null;

  const patterns = await listHeadlinePatterns(args.admin, args.workspaceId, {
    awarenessStage: args.temperature,
  });
  if (patterns.length === 0) return null;

  for (const angle of angles) {
    const legal = patterns.find((p) => patternIsLegalForAngle(p, angle, args.temperature));
    if (legal) return { angle, pattern: legal, theme: angle.theme };
  }
  return null;
}
