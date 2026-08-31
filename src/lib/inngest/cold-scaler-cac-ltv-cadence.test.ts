/**
 * Unit tests for the per-workspace cold-scaler-cac-ltv sweep — the pure
 * `dispatchColdScalerCacLtv` helper the Inngest handler wraps. Pins the
 * Phase-2 verification bullets from
 * [[../../../docs/brain/specs/cold-scaler-arming-decides-on-evidence-not-absence]]:
 * "the dispatcher enqueues exactly one job per workspace" and "is idempotent
 * within the ISO week". The sensor's own compare-and-set upsert test lives in
 * [[../media-buyer/cold-scaler-cac-ltv-sensor.test]] (`re-running for the
 * same (cohort, iso_week) upserts in place`); this file covers only the
 * dispatch layer. Mirrors the [[./sensor-trust-probe-cadence.test]] shape.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/cold-scaler-cac-ltv-cadence.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchColdScalerCacLtv,
  findColdScalerCacLtvWorkspaces,
  coldScalerCacLtvSpecSlug,
  COLD_SCALER_CAC_LTV_SPEC_SLUG,
  COLD_SCALER_CAC_LTV_IDEMPOTENCY_WINDOW_MS,
} from "./cold-scaler-cac-ltv-cadence";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function makeAdmin(tables: Tables) {
  return {
    from(table: string) {
      const rowsRef = () => (tables[table] ?? (tables[table] = []));
      const state: {
        filters: Array<(r: Row) => boolean>;
        limit?: number;
        selected?: string;
      } = { filters: [] };
      const chain = {
        select(cols: string) {
          state.selected = cols;
          return chain;
        },
        eq(col: string, val: unknown) {
          state.filters.push((r) => r[col] === val);
          return chain;
        },
        gte(col: string, val: unknown) {
          state.filters.push((r) => (r[col] as string) >= (val as string));
          return chain;
        },
        limit(n: number) {
          state.limit = n;
          return chain;
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          let out = rowsRef().filter((r) => state.filters.every((f) => f(r)));
          if (state.limit !== undefined) out = out.slice(0, state.limit);
          return Promise.resolve({ data: out, error: null }).then(resolve);
        },
        insert(row: Row | Row[]) {
          const arr = rowsRef();
          const rows = Array.isArray(row) ? row : [row];
          if (table === "agent_jobs") {
            for (const r of rows) {
              const slug = (r as Row).spec_slug;
              if (typeof slug !== "string" || slug.length === 0) {
                return Promise.resolve({
                  data: null,
                  error: {
                    message:
                      'null value in column "spec_slug" of relation "agent_jobs" violates not-null constraint',
                  },
                });
              }
            }
          }
          const asRow = (r: Row): Row => ({
            id: `job-${arr.length + 1}`,
            status: "queued",
            created_at: (r.created_at as string) ?? "2026-08-31T12:00:00.000Z",
            ...r,
          });
          for (const r of rows) arr.push(asRow(r));
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof dispatchColdScalerCacLtv>[0];
}

const WS_A = "ws-a";
const WS_B = "ws-b";
const NOW_MS = new Date("2026-08-31T12:00:00.000Z").getTime();

test("coldScalerCacLtvSpecSlug — stable, workspace-scoped, non-empty", () => {
  assert.equal(coldScalerCacLtvSpecSlug(), "cold-scaler-cac-ltv:workspace");
  assert.equal(coldScalerCacLtvSpecSlug(), COLD_SCALER_CAC_LTV_SPEC_SLUG);
  assert.ok(coldScalerCacLtvSpecSlug().length > 0);
});

test("dispatchColdScalerCacLtv — workspace with active scaler cohort → one agent_jobs row with spec_slug + kind", async () => {
  const tables: Tables = {
    media_buyer_cold_scaler_cohorts: [
      { id: "coh-1", workspace_id: WS_A, is_active: true },
    ],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchColdScalerCacLtv(admin, WS_A, NOW_MS);
  assert.equal(r.evaluated, 1);
  assert.equal(r.dispatched, 1);
  assert.equal(tables.agent_jobs.length, 1);
  const [job] = tables.agent_jobs;
  assert.equal(job.spec_slug, "cold-scaler-cac-ltv:workspace");
  assert.equal(job.kind, "cold-scaler-cac-ltv");
  assert.equal(job.workspace_id, WS_A);
  const instr = JSON.parse(String(job.instructions));
  assert.equal(instr.trigger, "cron");
});

test("dispatchColdScalerCacLtv — workspace with NO active scaler cohort → 0 jobs (evaluated=0)", async () => {
  const tables: Tables = {
    media_buyer_cold_scaler_cohorts: [
      { id: "coh-r", workspace_id: WS_A, is_active: false },
    ],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchColdScalerCacLtv(admin, WS_A, NOW_MS);
  assert.equal(r.evaluated, 0);
  assert.equal(r.dispatched, 0);
  assert.equal(tables.agent_jobs.length, 0);
});

test("dispatchColdScalerCacLtv — idempotent within 7d: a same-week re-fire dispatches 0 (regression guard)", async () => {
  const tables: Tables = {
    media_buyer_cold_scaler_cohorts: [
      { id: "coh-1", workspace_id: WS_A, is_active: true },
    ],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const first = await dispatchColdScalerCacLtv(admin, WS_A, NOW_MS);
  assert.equal(first.dispatched, 1);
  assert.equal(tables.agent_jobs.length, 1);

  // Same tick — Inngest retry / manual re-fire — must NOT insert a second row.
  const second = await dispatchColdScalerCacLtv(admin, WS_A, NOW_MS);
  assert.equal(second.evaluated, 1);
  assert.equal(second.dispatched, 0);
  assert.equal(tables.agent_jobs.length, 1);

  // 6d23h59m later — still inside the window → still 0.
  const almostAWeek = NOW_MS + COLD_SCALER_CAC_LTV_IDEMPOTENCY_WINDOW_MS - 60_000;
  const third = await dispatchColdScalerCacLtv(admin, WS_A, almostAWeek);
  assert.equal(third.dispatched, 0);
  assert.equal(tables.agent_jobs.length, 1);
});

test("dispatchColdScalerCacLtv — a next-week run (past 7d) DOES enqueue a fresh row", async () => {
  const tables: Tables = {
    media_buyer_cold_scaler_cohorts: [
      { id: "coh-1", workspace_id: WS_A, is_active: true },
    ],
    agent_jobs: [
      {
        id: "job-old",
        workspace_id: WS_A,
        kind: "cold-scaler-cac-ltv",
        spec_slug: "cold-scaler-cac-ltv:workspace",
        status: "completed",
        created_at: new Date(
          NOW_MS - COLD_SCALER_CAC_LTV_IDEMPOTENCY_WINDOW_MS - 60_000,
        ).toISOString(),
      },
    ],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchColdScalerCacLtv(admin, WS_A, NOW_MS);
  assert.equal(r.evaluated, 1);
  assert.equal(r.dispatched, 1);
  assert.equal(tables.agent_jobs.length, 2);
});

test("findColdScalerCacLtvWorkspaces — distinct workspace_ids from active scaler cohorts only", async () => {
  const tables: Tables = {
    media_buyer_cold_scaler_cohorts: [
      { id: "c1", workspace_id: WS_A, is_active: true },
      { id: "c2", workspace_id: WS_A, is_active: true }, // dup workspace
      { id: "c3", workspace_id: WS_B, is_active: true },
      { id: "c4", workspace_id: "ws-retired", is_active: false }, // filtered out
    ],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const ws = await findColdScalerCacLtvWorkspaces(admin);
  assert.deepEqual(new Set(ws), new Set([WS_A, WS_B]));
  assert.equal(ws.length, 2);
});
