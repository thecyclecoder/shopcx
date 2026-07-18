/**
 * Build-box page — lane-group display derivation.
 *
 * build-box-page-other-lanes-truthful-capacity-not-summed-caps Phase 1:
 * The heartbeat's `lane_groups` map (scripts/builder-worker.ts) carries every named lane pool's cap.
 * Four of those are REAL concurrent ceilings — build/plan (10), customer_service (5), director (2),
 * fold (1). The fifth (`other`) is a bag of ~32 independently-capped autonomous agents whose caps
 * (each 1-2) never co-run at their summed ceiling. Presenting the 'other' group as `active / SUM(all
 * per-kind MAX_*)` read as "4/35 in use" — a phantom ~35-lane pool that made the box look wildly
 * over-provisioned. This helper derives a truthful DISPLAY shape from the heartbeat: the real pools
 * keep their cap; the `other` bucket carries `cap: null` so the page renders "N active" without a
 * phantom /cap denominator and without phantom open cells. Per-kind caps stay enforced in the worker
 * — this is purely how the box page REPRESENTS the bucket.
 *
 * box-page-split-producer-vs-supervisory-lane-groups Phase 1:
 * The single `other` heartbeat group is a MIXED catch-all of genuine supervisors (spec-test,
 * deploy-review, agent-grade, ...) AND domain producers (ad-creative, ad-creative-copy-author,
 * dr-content, media-buyer, product-seed, storefront-optimizer). Rendering all of it under the
 * "Supervisory agents" label mislabels every producer — Dahlia (ad-creative-copy-author) reads as a
 * supervisor. The derivation now fans the single `other` group into TWO display sections at read
 * time: `producer` (artifact-creators, listed in PRODUCER_KINDS) and `supervisory` (everything
 * else — a default-supervisory fallthrough so a newly-added `other` kind can never silently vanish
 * from the display). The heartbeat's `other` lane_group is unchanged; owner functions, kill
 * switches, grading, and per-kind caps are untouched. Purely a display truth.
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
// open cells against that ceiling. `cap: null` → truthful active-count bucket, rendered as an
// active count (no phantom denominator, no open cells).
export interface LaneGroupSection<L extends LaneRowLike = LaneRowLike> {
  key: string;
  label: string;
  cap: number | null;
  lanes: L[];
}

// Display order for the lane groups the derivation emits. The heartbeat still emits a single
// `other` bucket; here it fans into `producer` then `supervisory` at position 5-6 so the CEO-flagged
// "Dahlia is a supervisor" mislabel goes away.
export const LANE_GROUP_ORDER = [
  "build_plan",
  "customer_service",
  "director",
  "fold",
  "producer",
  "supervisory",
] as const;

// Kinds that CREATE artifacts (ads, advertorials, campaigns, storefront changes, seeded products).
// Every kind NOT in this set that lives in the heartbeat's `other` bucket defaults to supervisory,
// so a newly-added `other` kind can never silently vanish from the display.
export const PRODUCER_KINDS = new Set<string>([
  "product-seed",
  "dr-content",
  "media-buyer",
  "ad-creative",
  "ad-creative-copy-author",
  "ad-creative-copy-qc",
  "storefront-optimizer",
]);

// Human labels. `producer`/`supervisory` are DISPLAY-only keys the derivation fans out of the
// heartbeat's single `other` bucket. `other` is retained (points at "Supervisory agents") as a
// belt-and-suspenders back-compat label for any surface that still reads the heartbeat's raw
// `other` group key directly.
export const LANE_GROUP_LABELS: Record<string, string> = {
  build_plan: "Build / plan lanes",
  customer_service: "Customer service lanes",
  director: "Director lanes",
  fold: "Fold lane",
  producer: "Producer agents",
  supervisory: "Supervisory agents",
  other: "Supervisory agents",
};

// Groups whose summed per-kind caps are a phantom ceiling and MUST be rendered as active-count only
// (no denominator). Producer + supervisory both carry cap:null by construction below.
const TRUTHFUL_ACTIVE_ONLY = new Set<string>(["other", "producer", "supervisory"]);

/**
 * Derive the ordered display sections from the heartbeat's lane_groups map + the in-flight lanes.
 * Returns null when the heartbeat row predates lane_groups (the page falls back to the legacy
 * single-pool render). The four real concurrent pools (build_plan / customer_service / director /
 * fold) render 1:1 from the heartbeat; the heartbeat's `other` bucket fans into TWO sections:
 * `producer` (kinds in PRODUCER_KINDS) and `supervisory` (everything else — default-supervisory).
 */
export function deriveLaneGroupSections<L extends LaneRowLike>(
  laneGroups: LaneGroupsMap | null | undefined,
  lanes: L[] | null | undefined,
): LaneGroupSection<L>[] | null {
  if (!laneGroups) return null;
  const rows = lanes ?? [];
  const out: LaneGroupSection<L>[] = [];
  for (const key of LANE_GROUP_ORDER) {
    if (key === "producer" || key === "supervisory") {
      // Both fan out of the heartbeat's single `other` bucket. Membership is a set intersection on
      // kind: any kind in the `other` group's kind-set that IS in PRODUCER_KINDS lands in producer;
      // everything else (including a kind the derivation code has never seen) defaults to
      // supervisory, so a newly-added `other` kind can never silently vanish from the display.
      const other = laneGroups.other;
      if (!other) continue;
      const kinds = new Set<string>();
      for (const k of other.kinds) {
        const isProducer = PRODUCER_KINDS.has(k);
        if (key === "producer" ? isProducer : !isProducer) kinds.add(k);
      }
      out.push({
        key,
        label: LANE_GROUP_LABELS[key],
        cap: null,
        lanes: rows.filter((l) => kinds.has(l.kind)),
      });
      continue;
    }
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
