/**
 * Regression coverage for the in-flight window guard in `auditAllKpis` — the guard extension
 * from daily-only to all cadences (Repair Agent signature `loop:kpi_drift:deploy_reliability:monthly`).
 *
 * Built-in `node:test` — run: `tsx --test src/lib/agents/kpi-review.test.ts`.
 *
 * The fake admin client models the `.from().select().eq().order().limit().lt()` chain as a filter
 * accumulator that applies filters → sort → limit at `await` time (matches Supabase semantics), so
 * the `.lt('snapshot_date', todayUtc())` guard is exercised end-to-end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { auditAllKpis } from "./kpi-review";
import type { ScorecardSnapshotRow } from "./platform-scorecard";
import type { createAdminClient } from "@/lib/supabase/admin";

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** First-of-last-month UTC, YYYY-MM-DD — the canonical "closed monthly window" fixture date. */
const firstOfLastMonthUtc = (): string => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 10);
};

/**
 * Minimal chainable Supabase stub scoped to `platform_scorecard_snapshots` reads. Accumulates
 * `.eq/.lt` filters + `.order/.limit`, and applies them (filter → sort → limit) when the chain is
 * awaited via `.then` — the same order Postgres uses, so the `.lt('snapshot_date', today)` guard
 * behaves as it does in prod.
 */
function fakeAdmin(rows: ScorecardSnapshotRow[]): ReturnType<typeof createAdminClient> {
  const build = () => {
    const filters: Array<(r: ScorecardSnapshotRow) => boolean> = [];
    let ascending = false;
    let limitN = Infinity;
    const chain = {
      select: () => chain,
      eq: (col: keyof ScorecardSnapshotRow, val: unknown) => {
        filters.push((r) => r[col] === val);
        return chain;
      },
      lt: (col: keyof ScorecardSnapshotRow, val: unknown) => {
        filters.push((r) => (r[col] as unknown as string) < (val as string));
        return chain;
      },
      order: (_col: string, opts: { ascending?: boolean } = {}) => {
        ascending = !!opts.ascending;
        return chain;
      },
      limit: (n: number) => {
        limitN = n;
        return chain;
      },
      then: (onFulfilled: (v: { data: ScorecardSnapshotRow[]; error: null }) => unknown) => {
        const filtered = rows.filter((r) => filters.every((f) => f(r)));
        const sorted = [...filtered].sort((a, b) =>
          ascending
            ? a.snapshot_date.localeCompare(b.snapshot_date)
            : b.snapshot_date.localeCompare(a.snapshot_date),
        );
        return Promise.resolve({ data: sorted.slice(0, limitN), error: null }).then(onFulfilled);
      },
    };
    return chain;
  };
  return { from: (_table: string) => build() } as unknown as ReturnType<typeof createAdminClient>;
}

test("auditAllKpis('monthly') skips a today-dated in-flight snapshot and picks the closed prior-month row (loop:kpi_drift:deploy_reliability:monthly regression)", async () => {
  const today = todayUtc();
  const priorMonth = firstOfLastMonthUtc();
  const workspaceId = "ws-1";
  const nowIso = new Date().toISOString();

  // Two rows for deploy_reliability: one dated TODAY (in-flight — must be excluded by the guard),
  // one dated the 1st of last month (closed window — the guard must land on this one). The
  // prior-month snapshot value matches the ground-truth compute stub exactly, so the audit lands a
  // withinTolerance=true report against the closed window.
  const rows: ScorecardSnapshotRow[] = [
    {
      workspace_id: workspaceId,
      metric_key: "deploy_reliability",
      cadence: "monthly",
      snapshot_date: today,
      window_days: 30,
      value: 0.9583, // the in-flight value from the originating incident
      prior_value: null,
      delta_pct: null,
      unit: "ratio",
      detail: { healthy: 46, rolled_back: 2, total: 48 },
      updated_at: nowIso,
    },
    {
      workspace_id: workspaceId,
      metric_key: "deploy_reliability",
      cadence: "monthly",
      snapshot_date: priorMonth,
      window_days: 30,
      value: 0.9615,
      prior_value: null,
      delta_pct: null,
      unit: "ratio",
      detail: { healthy: 50, rolled_back: 2, total: 52 },
      updated_at: nowIso,
    },
  ];

  const admin = fakeAdmin(rows);

  // The compute stub asserts the guard's contract directly: `auditAllKpis` must NEVER re-derive
  // ground truth for TODAY's snapshot_date (that's the moving-target compare the guard eliminates).
  const compute = async (
    _ws: string,
    opts: { cadence: string; snapshotDate?: string },
  ): Promise<ScorecardSnapshotRow[]> => {
    assert.notEqual(opts.snapshotDate, today, "guard must skip today's in-flight snapshot");
    assert.equal(opts.snapshotDate, priorMonth);
    return [
      {
        workspace_id: workspaceId,
        metric_key: "deploy_reliability",
        cadence: "monthly",
        snapshot_date: priorMonth,
        window_days: 30,
        value: 0.9615,
        prior_value: null,
        delta_pct: null,
        unit: "ratio",
        detail: { healthy: 50, rolled_back: 2, total: 52 },
        updated_at: nowIso,
      },
    ];
  };

  const reports = await auditAllKpis(workspaceId, "monthly", undefined, { admin, compute });
  const deploy = reports.find((r) => r.metric === "deploy_reliability");
  assert.ok(deploy, "expected a deploy_reliability audit report");
  assert.equal(
    deploy!.snapshotDate,
    priorMonth,
    "audit must land on the closed prior-month snapshot, not the today-dated in-flight one",
  );
  assert.notEqual(deploy!.snapshotDate, today);
  assert.equal(deploy!.withinTolerance, true, "closed-window compare is within the ratio tolerance");
});
