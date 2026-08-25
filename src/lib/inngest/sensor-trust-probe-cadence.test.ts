/**
 * Unit tests for the per-workspace sensor-trust-probe sweep — the pure
 * `dispatchSensorTrustProbe` helper the Inngest handler wraps. Pins the two
 * Phase-1 verification bullets from
 * [[../../../docs/brain/specs/cold-scaler-arming-decides-on-evidence-not-absence]]:
 * "the dispatcher enqueues exactly one job per workspace" and "is idempotent
 * within a day". Mirrors the [[./media-buyer-grade.test]] shape.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/sensor-trust-probe-cadence.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchSensorTrustProbe,
  findSensorTrustProbeWorkspaces,
  sensorTrustProbeSpecSlug,
  SENSOR_TRUST_PROBE_SPEC_SLUG,
  SENSOR_TRUST_PROBE_IDEMPOTENCY_WINDOW_MS,
} from "./sensor-trust-probe-cadence";

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
            created_at: (r.created_at as string) ?? "2026-08-25T12:00:00.000Z",
            ...r,
          });
          for (const r of rows) arr.push(asRow(r));
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof dispatchSensorTrustProbe>[0];
}

const WS_A = "ws-a";
const WS_B = "ws-b";
const NOW_MS = new Date("2026-08-25T12:00:00.000Z").getTime();

test("sensorTrustProbeSpecSlug — stable, workspace-scoped, non-empty", () => {
  assert.equal(sensorTrustProbeSpecSlug(), "sensor-trust-probe:workspace");
  assert.equal(sensorTrustProbeSpecSlug(), SENSOR_TRUST_PROBE_SPEC_SLUG);
  assert.ok(sensorTrustProbeSpecSlug().length > 0);
});

test("dispatchSensorTrustProbe — workspace with active cohort → one agent_jobs row with spec_slug + kind", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [
      { id: "coh-1", workspace_id: WS_A, is_active: true },
    ],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchSensorTrustProbe(admin, WS_A, NOW_MS);
  assert.equal(r.evaluated, 1);
  assert.equal(r.dispatched, 1);
  assert.equal(tables.agent_jobs.length, 1);
  const [job] = tables.agent_jobs;
  assert.equal(job.spec_slug, "sensor-trust-probe:workspace");
  assert.equal(job.kind, "sensor-trust-probe");
  assert.equal(job.workspace_id, WS_A);
  const instr = JSON.parse(String(job.instructions));
  assert.equal(instr.trigger, "cron");
});

test("dispatchSensorTrustProbe — workspace with NO active cohort → 0 jobs (evaluated=0)", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [
      { id: "coh-r", workspace_id: WS_A, is_active: false },
    ],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchSensorTrustProbe(admin, WS_A, NOW_MS);
  assert.equal(r.evaluated, 0);
  assert.equal(r.dispatched, 0);
  assert.equal(tables.agent_jobs.length, 0);
});

test("dispatchSensorTrustProbe — idempotent within 24h: a same-day re-fire dispatches 0 (regression guard)", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [
      { id: "coh-1", workspace_id: WS_A, is_active: true },
    ],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const first = await dispatchSensorTrustProbe(admin, WS_A, NOW_MS);
  assert.equal(first.dispatched, 1);
  assert.equal(tables.agent_jobs.length, 1);

  // Same tick — Inngest retry / manual re-fire — must NOT insert a second row.
  const second = await dispatchSensorTrustProbe(admin, WS_A, NOW_MS);
  assert.equal(second.evaluated, 1);
  assert.equal(second.dispatched, 0);
  assert.equal(tables.agent_jobs.length, 1);

  // 23h59m later — still inside the window → still 0.
  const almostADay = NOW_MS + SENSOR_TRUST_PROBE_IDEMPOTENCY_WINDOW_MS - 60_000;
  const third = await dispatchSensorTrustProbe(admin, WS_A, almostADay);
  assert.equal(third.dispatched, 0);
  assert.equal(tables.agent_jobs.length, 1);
});

test("dispatchSensorTrustProbe — a next-day run (past 24h) DOES enqueue a fresh row", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [
      { id: "coh-1", workspace_id: WS_A, is_active: true },
    ],
    agent_jobs: [
      {
        id: "job-old",
        workspace_id: WS_A,
        kind: "sensor-trust-probe",
        spec_slug: "sensor-trust-probe:workspace",
        status: "completed",
        created_at: new Date(NOW_MS - SENSOR_TRUST_PROBE_IDEMPOTENCY_WINDOW_MS - 60_000).toISOString(),
      },
    ],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchSensorTrustProbe(admin, WS_A, NOW_MS);
  assert.equal(r.evaluated, 1);
  assert.equal(r.dispatched, 1);
  assert.equal(tables.agent_jobs.length, 2);
});

test("findSensorTrustProbeWorkspaces — distinct workspace_ids from active cohorts only", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [
      { id: "c1", workspace_id: WS_A, is_active: true },
      { id: "c2", workspace_id: WS_A, is_active: true }, // dup workspace
      { id: "c3", workspace_id: WS_B, is_active: true },
      { id: "c4", workspace_id: "ws-retired", is_active: false }, // filtered out
    ],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const ws = await findSensorTrustProbeWorkspaces(admin);
  assert.deepEqual(new Set(ws), new Set([WS_A, WS_B]));
  assert.equal(ws.length, 2);
});
