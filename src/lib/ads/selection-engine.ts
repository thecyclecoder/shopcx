/**
 * selection-engine — the v3 portfolio selector for Dahlia's next (angle × pattern) shot.
 *
 * The two READERS the selector's rail is built on
 * (from [[../../docs/brain/specs/selection-engine-coverage-ledger.md]] Phase 1):
 *   • `listEligibleCombinations({admin, workspaceId, productId, temperature})` — the fresh,
 *     cooldown-eligible combinations for a product, joined against the palette (via the
 *     [[angle-palette]] SDK) and the temperature-legal, consumes-fillable patterns (via
 *     the [[headline-patterns]] SDK). One deterministic view of "what can we ship right now?"
 *   • `readLiveBinThemeDistribution({admin, workspaceId, productId})` — the live map from
 *     theme → count of `status='ready'` [[../../docs/brain/tables/ad_campaigns.md]] rows,
 *     the quota the theme-spread rail measures against.
 *
 * The PICKER (`pickNextCombination`) layers the 70/30 explore/exploit split on top. The
 * exploit slot (30% of picks) is biased by the significance-gated factor rollup — the
 * [[../../docs/brain/specs/factor-scores-reweight-selection-engine.md]] Phase 1 wiring
 * that closes the v3 goal's quant-desk loop: `getFactorRollup` returns per-combination
 * ROAS/CPA/purchases numbers with a `significance.passesGate` verdict, and the exploit
 * branch prefers the highest-ROAS passesGate row instead of the pre-Phase-1
 * angle-palette `status='crowned'` flag. A cold-start or not-yet-tested product falls
 * back to the crowned-status pick with `exploitSource:'palette_status_crown_fallback'`
 * so nothing regresses. Every return carries `exploitSource` + `biasedByFactors` so the
 * Phase-3 director_activity audit trail can cite the numbers verbatim.
 *
 * All coverage bumps + combination upserts stay in [[creative-combinations]]; this module
 * is read-only. All palette/pattern reads route through their existing SDK chokepoints —
 * never raw `.from('product_angle_palette')` or `.from('ad_headline_patterns')` here.
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
import {
  getFactorRollup,
  type CombinationRollupRow,
  type FactorRollupOutput,
} from "./factor-rollup-sdk";

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

/** Portfolio-selector explore/exploit ratio — the 70/30 split the v3 goal names. Named
 *  export so a future tuner or shadow-mode override moves it in one place. */
export const EXPLOIT_RATIO = 0.3;

/** Lookback window (days) `pickNextCombination` scopes the factor-rollup read to when
 *  ranking the exploit slot. 30d matches the M5 quant-desk cadence — long enough to
 *  clear the min-purchases threshold on a mid-scale spend, short enough that a decayed
 *  crown doesn't win over a fresher passesGate combination.
 *  ([[../../docs/brain/specs/factor-scores-reweight-selection-engine.md]] Phase 1.) */
export const EXPLOIT_LOOKBACK_DAYS = 30;

/** Which slot the picker fired for this pick — 'explore' = the 70% fresh sample,
 *  'exploit' = the 30% best-known bet. */
export type PickIntent = "explore" | "exploit";

/** Why the exploit slot chose what it chose. Emitted on every exploit-branch return so
 *  the Phase-3 director_activity audit trail can distinguish a real-numbers pick from
 *  the crowned-status fallback. Empty on an explore return. */
export type ExploitSource =
  | "factor_rollup_roas"
  | "palette_status_crown_fallback"
  | null;

/** The exact numbers the exploit slot biased on. `combination_id` is present on both
 *  the ROAS-ranked path AND the crown fallback (the crowned combination's id). The
 *  metric fields are populated only when the row came from a passesGate rollup — the
 *  crowned-status fallback has no numbers to cite (that IS the point of Phase 1). */
export interface BiasedByFactors {
  combination_id?: string;
  roas?: number | null;
  purchases?: number;
  spend_cents?: number;
}

/** One picker return: the (angle, pattern, theme, combination) tuple to ship, tagged
 *  with which slot chose it and — for exploit — how. */
export interface PickResult {
  angle: ProductAngle;
  pattern: HeadlinePattern;
  theme: AngleTheme;
  combination: CreativeCombination;
  intent: PickIntent;
  /** Populated on `intent='exploit'`; `null` on 'explore'. */
  exploitSource: ExploitSource;
  /** Populated on `intent='exploit'`; empty object on 'explore'. */
  biasedByFactors: BiasedByFactors;
}

export interface PickNextCombinationArgs {
  admin: Admin;
  workspaceId: string;
  productId: string;
  temperature: AwarenessStage;
  /** Explore/exploit dice roll — defaults to `Math.random()`. Tests pin it so the
   *  branch under test fires deterministically. */
  rand?: () => number;
  /** Override for tests — defaults to `new Date().toISOString()`. */
  nowIso?: string;
  /** Override for tests — defaults to `EXPLOIT_LOOKBACK_DAYS`. */
  exploitLookbackDays?: number;
}

interface CrownedCombinationCandidate {
  combination: CreativeCombination;
  angle: ProductAngle;
  pattern: HeadlinePattern;
  theme: AngleTheme;
}

/**
 * Sort the rollup's byCombination rows by ROAS desc, then purchases desc, then
 * spend_cents desc — the tie-break stack Phase 1 pins so the ranking is deterministic
 * on repeated picks. Only rows that already passed the significance gate AND have a
 * non-null ROAS get here; the caller filters before sorting.
 */
export function rankSignificancePassedByRoas(
  rows: CombinationRollupRow[],
): CombinationRollupRow[] {
  const eligible = rows.filter(
    (r) => r.significance.passesGate && r.roas != null,
  );
  return [...eligible].sort((a, b) => {
    const roasA = a.roas ?? -Infinity;
    const roasB = b.roas ?? -Infinity;
    if (roasA !== roasB) return roasB - roasA;
    if (a.purchases !== b.purchases) return b.purchases - a.purchases;
    if (a.spend_cents !== b.spend_cents) return b.spend_cents - a.spend_cents;
    return 0;
  });
}

/** Resolve a rollup row's `combination_id` back to the {combination, angle, pattern,
 *  theme} tuple by looking up the combination via [[creative-combinations]] and
 *  reading its angle from [[angle-palette]] + pattern from [[headline-patterns]].
 *  Returns null if any lookup misses — the exploit slot skips a row it can't compose. */
async function resolveCombinationToShot(
  admin: Admin,
  workspaceId: string,
  productId: string,
  temperature: AwarenessStage,
  combinationId: string,
): Promise<CrownedCombinationCandidate | null> {
  const [combos, palette, patterns] = await Promise.all([
    listCombinationsForProduct(admin, { workspaceId, productId }),
    listAnglePalette(admin, workspaceId, productId, {}),
    listHeadlinePatterns(admin, workspaceId, {}),
  ]);
  const combo = combos.find((c) => c.id === combinationId);
  if (!combo) return null;
  const angle = palette.find((a) => a.id === combo.angleId);
  if (!angle) return null;
  const pattern = patterns.find((p) => p.id === combo.patternId);
  if (!pattern) return null;
  if (!patternFillableByAngle(pattern, angle, temperature)) return null;
  return { combination: combo, angle, pattern, theme: angle.theme };
}

/** Load the crowned-status combinations for a product and join them against the
 *  palette + patterns SDKs. Used by the exploit slot's cold-start fallback — when the
 *  factor rollup returns zero passesGate rows, the picker still delivers a bet from
 *  the pre-Phase-1 crowned-status flag so the caller never starves. */
async function loadCrownedCandidates(
  admin: Admin,
  args: PickNextCombinationArgs,
): Promise<CrownedCombinationCandidate[]> {
  const [angles, patterns, crownedCombos] = await Promise.all([
    listAnglePalette(admin, args.workspaceId, args.productId, {}),
    listHeadlinePatterns(admin, args.workspaceId, {
      awarenessStage: args.temperature,
    }),
    listCombinationsForProduct(admin, {
      workspaceId: args.workspaceId,
      productId: args.productId,
      status: "crowned",
    }),
  ]);
  if (crownedCombos.length === 0) return [];
  const angleById = new Map(angles.map((a) => [a.id, a]));
  const patternById = new Map(patterns.map((p) => [p.id, p]));
  const out: CrownedCombinationCandidate[] = [];
  for (const combo of crownedCombos) {
    const angle = angleById.get(combo.angleId);
    if (!angle) continue;
    const pattern = patternById.get(combo.patternId);
    if (!pattern) continue;
    if (!patternFillableByAngle(pattern, angle, args.temperature)) continue;
    out.push({ combination: combo, angle, pattern, theme: angle.theme });
  }
  return out;
}

/**
 * Choose the exploit-slot pick. Consults `getFactorRollup` scoped to the workspace +
 * product + lookback window, filters `byCombination` to significance-passed rows with
 * non-null ROAS, ranks by ROAS desc / purchases desc / spend_cents desc, and returns
 * the top row resolved back to {combination, angle, pattern, theme} with
 * `exploitSource:'factor_rollup_roas'` + `biasedByFactors` naming the winning
 * combination and its numbers verbatim.
 *
 * Falls back to `loadCrownedCandidates` (the pre-Phase-1 crowned-status behaviour)
 * when the rollup returns zero passesGate rows OR when every ranked row fails to
 * resolve back to a legal shot for this temperature — a cold start or a not-yet-
 * tested product still returns SOMETHING with
 * `exploitSource:'palette_status_crown_fallback'` so the audit trail can cite why.
 * Returns `null` only when even the crowned-status fallback has no legal shot; the
 * caller (`pickNextCombination`) then fires the fresh slot instead of starving.
 *
 * Exported so `pickNextCombination` composes it AND unit tests can pin the exploit-
 * ranking predicate without threading the whole 70/30 dice roll.
 */
export async function pickExploitCombination(
  args: PickNextCombinationArgs,
  rollup?: FactorRollupOutput,
): Promise<PickResult | null> {
  const lookbackDays = args.exploitLookbackDays ?? EXPLOIT_LOOKBACK_DAYS;
  const rollupOut =
    rollup ??
    (await getFactorRollup(args.admin, {
      workspaceId: args.workspaceId,
      productId: args.productId,
      lookbackDays,
      nowIso: args.nowIso,
    }));
  const ranked = rankSignificancePassedByRoas(rollupOut.byCombination);
  for (const row of ranked) {
    const shot = await resolveCombinationToShot(
      args.admin,
      args.workspaceId,
      args.productId,
      args.temperature,
      row.combination_id,
    );
    if (!shot) continue;
    return {
      angle: shot.angle,
      pattern: shot.pattern,
      theme: shot.theme,
      combination: shot.combination,
      intent: "exploit",
      exploitSource: "factor_rollup_roas",
      biasedByFactors: {
        combination_id: row.combination_id,
        roas: row.roas,
        purchases: row.purchases,
        spend_cents: row.spend_cents,
      },
    };
  }

  const crowned = await loadCrownedCandidates(args.admin, args);
  if (crowned.length === 0) return null;
  const pick = crowned[0]!;
  return {
    angle: pick.angle,
    pattern: pick.pattern,
    theme: pick.theme,
    combination: pick.combination,
    intent: "exploit",
    exploitSource: "palette_status_crown_fallback",
    biasedByFactors: { combination_id: pick.combination.id },
  };
}

/**
 * Pick the next (angle × pattern × combination) shot for a product at a temperature.
 * Dice-rolls the 70/30 explore/exploit split; on exploit, calls
 * [[pickExploitCombination]] to consult the factor rollup and bias by real ROAS
 * numbers ([[../../docs/brain/specs/factor-scores-reweight-selection-engine.md]]
 * Phase 1). On explore — OR on exploit-returns-null (a cold-start product with no
 * crowned combinations either) — picks the first shot off
 * [[listEligibleCombinations]] so the caller never starves silently.
 *
 * Returns `null` only when BOTH slots find no legal shot (the fresh sample is empty
 * AND the crowned-status fallback is empty) — the escalation path the coverage
 * ledger spec names so the caller can enqueue an angle-fanout job.
 *
 * This function is the composition point later phases extend: Phase 2 of THIS spec
 * adds the fresh-sample loser filter + theme-quota + pattern-fatigue dampening; Phase
 * 3 writes the director_activity audit row on every return.
 */
export async function pickNextCombination(
  args: PickNextCombinationArgs,
): Promise<PickResult | null> {
  const rand = args.rand ?? Math.random;
  const exploitBranchFires = rand() < EXPLOIT_RATIO;

  if (exploitBranchFires) {
    const exploit = await pickExploitCombination(args);
    if (exploit) return exploit;
    // Cold-start: no rollup rows AND no crowned combinations — fall through to fresh.
  }

  const eligible = await listEligibleCombinations({
    admin: args.admin,
    workspaceId: args.workspaceId,
    productId: args.productId,
    temperature: args.temperature,
    nowIso: args.nowIso,
  });
  if (eligible.length === 0) return null;
  const shot = eligible[0]!;
  return {
    angle: shot.angle,
    pattern: shot.pattern,
    theme: shot.theme,
    combination: shot.combination,
    intent: "explore",
    exploitSource: null,
    biasedByFactors: {},
  };
}
