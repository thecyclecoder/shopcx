/**
 * dahlia-rubric-gate — Phase 3 of dahlia-researches-from-winners-flow-ad-library. The
 * ready-to-bin quality gate that reads Max's Phase-2 5-axis rubric composite (0..10)
 * against the per-workspace threshold and decides whether to insert the creative into
 * Bianca's ready-to-test bin, revise it (feed the per-axis reasons back to Dahlia), or
 * escalate (bounded-retry exhausted).
 *
 * SHIPPED as pure helpers + a fail-closed setpoint reader. The M1 keystone dispatcher
 * (still in flight — see `runQaCreativeCopyViaBoxSession` in `./creative-qa` for the
 * seam) will consume this module to gate the bin insert; the gate + reader + retry cap
 * live here so they're pinned by their own vitest and stay independent of the
 * still-moving dispatcher wiring.
 *
 *   • computeDahliaRubricComposite(rubric) → 0..10 (rounded avg of 5 axes)
 *   • evaluateReadyToBinGate({ composite, threshold, attemptIndex, maxAttempts, rubric })
 *       → { kind: 'bin' } | { kind: 'revise', reasons } | { kind: 'exhausted', composite }
 *   • resolveDahliaRubricMinComposite(admin, workspaceId) → { ok, value | reason }
 *
 * FAIL-CLOSED reader (same pattern as `resolveLf8UnderperformanceThreshold` in
 * ads-supervisor): a Supabase read error or missing iteration_policies row returns
 * `{ ok: false, reason }`. The Phase-3 gate MUST refuse to auto-bin on an unproven
 * threshold — falling back to a hardcoded 7 would let a workspace with a raised
 * threshold silently accept sub-bar creatives. The caller's exhaustion policy takes
 * over.
 *
 * REVISE-LOOP CAP (`MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS = 3`, kept as a const so the cap
 * is greppable + a divergence with the caller is obvious): the total sanctioned pass
 * count is 1 + MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS. On exhaustion the caller inserts a
 * `director_activity` `action_kind='dahlia_rubric_gate_exhausted'` row and HOLDS the
 * campaign out of the bin — never silently downgrades to `draft`.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { DahliaCreativeRubric, DahliaRubricAxis } from "./creative-qa";
import { DAHLIA_RUBRIC_AXES } from "./creative-qa";

type Admin = ReturnType<typeof createAdminClient>;

/** The DEFAULT threshold — the spec's "default 7/10 composite" bar. Also the reader's
 *  fallback when the row's `dahlia_rubric_min_composite` column is null (should not
 *  happen: the DB column is NOT NULL DEFAULT 7, but the reader is null-safe so a
 *  pre-migration row / a rebased snapshot still lands at 7 by construction). */
export const DAHLIA_RUBRIC_MIN_COMPOSITE_DEFAULT = 7;

/** Total sanctioned attempts per creative = 1 + MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS. Set
 *  to 3 (four passes total): the first attempt + 3 sanctioned revises. Above that the
 *  gate returns `exhausted` and the caller HOLDS the campaign out of the bin. */
export const MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS = 3;

/** Fail-closed shape mirroring `Lf8GateThreshold` in `ads-supervisor.ts` — `ok:true` on a
 *  successful read; `ok:false` with a reason on error / missing row. */
export type DahliaRubricGateThreshold =
  | { ok: true; value: number }
  | { ok: false; reason: string };

/**
 * PURE — sum the five 1..10 axis scores and round to the nearest integer for the
 * composite. Kept as an integer so the ledger + the setpoint speak the same units. A
 * malformed rubric (out-of-range axis score) is a Phase-2 parser defect — this function
 * assumes valid input (each axis 1..10) and clamps defensively to 0..10 so a bad row
 * can't crash the gate.
 *
 * The composite is the AVERAGE (rounded), NOT the sum — so a threshold of 7 means "each
 * axis averaged ≥7," which is the intuitive reading of "≥7/10 composite" in the spec.
 * Rounding uses `Math.round` (banker's rounding is Node's built-in Math.round: away from
 * zero on .5). Composite range 1..10 (inclusive) — the axis floor is 1, so a valid rubric
 * cannot round to 0.
 */
export function computeDahliaRubricComposite(rubric: DahliaCreativeRubric): number {
  let sum = 0;
  for (const axis of DAHLIA_RUBRIC_AXES) {
    const raw = rubric[axis]?.score ?? 0;
    const clamped = Math.max(0, Math.min(10, raw));
    sum += clamped;
  }
  const avg = sum / DAHLIA_RUBRIC_AXES.length;
  return Math.max(0, Math.min(10, Math.round(avg)));
}

/** The per-axis miss surface the caller feeds back to Dahlia on a revise. Ordered by
 *  score ASC so the WORST axes lead the revise prompt (Dahlia sees the biggest misses
 *  first — the most likely target for the fix). Ties preserve `DAHLIA_RUBRIC_AXES` order
 *  so the output is deterministic. */
export interface DahliaRubricAxisMiss {
  axis: DahliaRubricAxis;
  score: number;
  reason: string;
}

/** PURE — collect the axes that scored strictly BELOW the threshold, ordered worst-first
 *  (score ASC), preserving `DAHLIA_RUBRIC_AXES` order on ties. Used by the revise-loop
 *  prompt builder AND by the `revise` outcome (so downstream can grep which axes tripped). */
export function collectAxisMisses(
  rubric: DahliaCreativeRubric,
  threshold: number,
): DahliaRubricAxisMiss[] {
  const misses: DahliaRubricAxisMiss[] = [];
  for (const axis of DAHLIA_RUBRIC_AXES) {
    const { score, reason } = rubric[axis];
    if (score < threshold) misses.push({ axis, score, reason });
  }
  misses.sort((a, b) => a.score - b.score);
  return misses;
}

/** Discriminated outcome of the ready-to-bin gate. `bin` = flip to ready-to-test.
 *  `revise` = feed axis misses back to Dahlia + regenerate (still under the cap).
 *  `exhausted` = revise cap reached; caller escalates + HOLDS the campaign out of the bin. */
export type DahliaRubricGateOutcome =
  | { kind: "bin"; composite: number }
  | { kind: "revise"; composite: number; misses: DahliaRubricAxisMiss[]; nextAttemptIndex: number }
  | { kind: "exhausted"; composite: number; misses: DahliaRubricAxisMiss[] };

export interface EvaluateReadyToBinGateInput {
  rubric: DahliaCreativeRubric;
  threshold: number;
  /** 0-based — the FIRST QC attempt is `attemptIndex:0`; a `revise` outcome hands the
   *  caller the `nextAttemptIndex` to hand back on the next call. */
  attemptIndex: number;
  /** Optional override; defaults to `MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS` above. */
  maxReviseAttempts?: number;
}

/**
 * PURE gate — decide whether this creative is bin-ready, needs a revise, or has
 * exhausted the retry cap. The composite is computed from the rubric; the threshold is
 * the caller's (from `resolveDahliaRubricMinComposite`); the retry cap is
 * `MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS` unless overridden.
 *
 * The decision:
 *   - composite ≥ threshold                             → { bin }
 *   - composite < threshold AND attemptIndex < cap      → { revise, misses, nextAttemptIndex }
 *   - composite < threshold AND attemptIndex ≥ cap      → { exhausted, misses }
 *
 * When bin-ready, the outcome carries the composite so the ledger can record it on the
 * final row. When revising, the outcome carries the sorted axis misses (worst-first) so
 * the caller can build the revise prompt without recomputing.
 */
export function evaluateReadyToBinGate(
  input: EvaluateReadyToBinGateInput,
): DahliaRubricGateOutcome {
  const composite = computeDahliaRubricComposite(input.rubric);
  const cap = input.maxReviseAttempts ?? MAX_DAHLIA_RUBRIC_REVISE_ATTEMPTS;
  if (composite >= input.threshold) return { kind: "bin", composite };
  const misses = collectAxisMisses(input.rubric, input.threshold);
  // attemptIndex is the ATTEMPT that just finished (0-based). It has failed. If we have
  // room for at least one more revise, ask for it; otherwise the cap is spent.
  if (input.attemptIndex + 1 <= cap) {
    return { kind: "revise", composite, misses, nextAttemptIndex: input.attemptIndex + 1 };
  }
  return { kind: "exhausted", composite, misses };
}

/**
 * FAIL-CLOSED reader — return the workspace's active
 * `iteration_policies.dahlia_rubric_min_composite`, mirroring `resolveLf8UnderperformanceThreshold`
 * in `ads-supervisor.ts`. A Supabase read error OR a missing iteration_policies row
 * returns `{ ok: false, reason }`; the caller MUST NOT auto-bin on an unproven threshold
 * (would let a workspace with a raised threshold silently accept sub-bar creatives).
 *
 * A row with a NULL `dahlia_rubric_min_composite` column falls back to
 * `DAHLIA_RUBRIC_MIN_COMPOSITE_DEFAULT` (7) — the DB column is NOT NULL DEFAULT 7 so
 * this branch only fires for a pre-migration row / a manually-inserted row skipping the
 * default. The `iteration_policies` row is selected newest-first (same convention as
 * `resolveLf8UnderperformanceThreshold`), so a workspace's most-recent tuned setpoint
 * wins.
 */
export async function resolveDahliaRubricMinComposite(
  admin: Admin,
  workspaceId: string,
): Promise<DahliaRubricGateThreshold> {
  const { data, error } = await admin
    .from("iteration_policies")
    .select("dahlia_rubric_min_composite")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return { ok: false, reason: `iteration_policies read failed: ${error.message}` };
  }
  if (data == null) {
    return { ok: false, reason: `no iteration_policies row for workspace ${workspaceId}` };
  }
  const raw = (data as { dahlia_rubric_min_composite: number | null }).dahlia_rubric_min_composite;
  return { ok: true, value: raw == null ? DAHLIA_RUBRIC_MIN_COMPOSITE_DEFAULT : Number(raw) };
}
