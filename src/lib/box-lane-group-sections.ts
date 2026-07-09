/**
 * Build-box page — lane-group display derivation.
 *
 * build-box-page-other-lanes-truthful-capacity-not-summed-caps Phase 1:
 * The heartbeat's `lane_groups` map (scripts/builder-worker.ts) carries every named lane pool's cap.
 * Four of those are REAL concurrent ceilings — build/plan (10), customer_service (5), director (2),
 * fold (1). The fifth (`other`) is a bag of ~32 independently-capped supervisory agents whose caps
 * (each 1-2) never co-run at their summed ceiling. Presenting the 'other' group as `active / SUM(all
 * per-kind MAX_*)` read as "4/35 in use" — a phantom ~35-lane pool that made the box look wildly
 * over-provisioned. This helper derives a truthful DISPLAY shape from the heartbeat: the real pools
 * keep their cap; the supervisory bucket carries `cap: null` so the page renders "N active" without
 * a phantom /cap denominator and without phantom open cells. Per-kind caps stay enforced in the
 * worker — this is purely how the box page REPRESENTS the bucket.
 *
 * Pure — no React, no DB. Tested from src/lib/box-lane-group-sections.test.ts.
 */

// Minimal lane shape the derivation needs — the page's LaneRow (page.tsx) satisfies this.
export interface LaneRowLike {
  kind: string;
}

// The heartbeat's lane_groups jsonb column shape (see scripts/builder-worker.ts LANE_GROUPS).
export interface LaneGroupsMap {
  [group: string]: { cap: number; kinds: readonly string[] | string[] };
}

// One display section per named lane group. `cap: number` → real concurrent pool, rendered with
// open cells against that ceiling. `cap: null` → truthful supervisory bucket, rendered as an active
// count (no phantom denominator, no open cells).
export interface LaneGroupSection<L extends LaneRowLike = LaneRowLike> {
  key: string;
  label: string;
  cap: number | null;
  lanes: L[];
}

// Display order for the lane groups the heartbeat emits. An unknown group key is skipped by the
// filter below; a NEW group added on the box shows up once its key is added here.
export const LANE_GROUP_ORDER = ["build_plan", "customer_service", "director", "fold", "other"] as const;

// Human labels. `other` → "Supervisory agents" — the bucket is a set of independently-capped
// autonomous supervisory workers (spec-test, agent-grade, agent-coach, research, dr-content, …),
// NOT a real concurrent pool. Every other named pool keeps its "lanes" wording.
export const LANE_GROUP_LABELS: Record<string, string> = {
  build_plan: "Build / plan lanes",
  customer_service: "Customer service lanes",
  director: "Director lanes",
  fold: "Fold lane",
  other: "Supervisory agents",
};

// Groups whose summed per-kind caps are a phantom ceiling and MUST be rendered as active-count only
// (no denominator). Kept as a set so a future bucket with the same shape can opt in by name.
const TRUTHFUL_ACTIVE_ONLY = new Set<string>(["other"]);

/**
 * Derive the ordered display sections from the heartbeat's lane_groups map + the in-flight lanes.
 * Returns null when the heartbeat row predates lane_groups (the page falls back to the legacy
 * single-pool render). Each section's `lanes` is filtered by the group's kind-set — the same
 * behavior as build-box-page-reflects-real-per-lane-group-usage, unchanged.
 */
export function deriveLaneGroupSections<L extends LaneRowLike>(
  laneGroups: LaneGroupsMap | null | undefined,
  lanes: L[] | null | undefined,
): LaneGroupSection<L>[] | null {
  if (!laneGroups) return null;
  const rows = lanes ?? [];
  const out: LaneGroupSection<L>[] = [];
  for (const key of LANE_GROUP_ORDER) {
    const g = laneGroups[key];
    if (!g) continue;
    const kindSet = new Set(g.kinds);
    const filtered = rows.filter((l) => kindSet.has(l.kind));
    out.push({
      key,
      label: LANE_GROUP_LABELS[key] ?? key,
      cap: TRUTHFUL_ACTIVE_ONLY.has(key) ? null : g.cap,
      lanes: filtered,
    });
  }
  return out;
}
