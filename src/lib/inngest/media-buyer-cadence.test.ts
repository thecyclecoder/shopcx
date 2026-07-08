/**
 * Unit tests for the per-workspace media-buyer-cadence sweep — the pure
 * `dispatchMediaBuyerCadence` helper the Inngest handler wraps. Asserts the three
 * verification bullets in media-buyer-daily-cadence-cron Phase 1 that map to a
 * unit-testable seam (the fourth — heartbeat / event fan-out at the cron level —
 * is exercised via the Inngest dev endpoint in the spec's manual verification).
 *
 * Run:
 *   npx tsx --test src/lib/inngest/media-buyer-cadence.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchMediaBuyerCadence,
  utcDayStartIso,
  ACTIVE_MEDIA_BUYER_JOB_STATUSES,
} from "./media-buyer-cadence";

// ── Fake admin client (mirrors src/lib/media-buyer/publish-gate.test.ts) ─────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Filter {
  kind: "eq" | "gte";
  col: string;
  val: unknown;
}

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    if (f.kind === "eq" && v !== f.val) return false;
    if (
      f.kind === "gte" &&
      !(typeof v === "string" && typeof f.val === "string" && v >= f.val)
    ) {
      return false;
    }
  }
  return true;
}

interface FakeChain {
  select: (...args: unknown[]) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  gte: (col: string, val: unknown) => FakeChain;
  then: (onFulfilled: (v: { data: Row[]; error: null }) => unknown) => Promise<unknown>;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  const resolve = () => {
    const all = tables[table] ?? [];
    return { data: all.filter((r) => matches(r, filters)), error: null as null };
  };
  const chain: FakeChain = {
    select: () => chain,
    eq: (col, val) => {
      filters.push({ kind: "eq", col, val });
      return chain;
    },
    gte: (col, val) => {
      filters.push({ kind: "gte", col, val });
      return chain;
    },
    then: (onFulfilled) => Promise.resolve(resolve()).then(onFulfilled),
  };
  return chain;
}

function makeAdmin(tables: Tables) {
  return {
    from(table: string) {
      return {
        select: (...args: unknown[]) => makeChain(tables, table).select(...args),
        eq: (col: string, val: unknown) => makeChain(tables, table).eq(col, val),
        gte: (col: string, val: unknown) => makeChain(tables, table).gte(col, val),
        insert: async (row: Row | Row[]) => {
          const arr = tables[table] ?? (tables[table] = []);
          const now = "2026-07-08T13:00:00.000Z";
          const asRow = (r: Row): Row => ({
            id: `job-${arr.length + 1}`,
            status: "queued",
            created_at: now,
            ...r,
          });
          if (Array.isArray(row)) arr.push(...row.map(asRow));
          else arr.push(asRow(row));
          return { data: null, error: null };
        },
      };
    },
  } as unknown as Parameters<typeof dispatchMediaBuyerCadence>[0];
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const WS = "ws-1";
const ACCT_A = "acct-A";
const ACCT_B = "acct-B";

function cohortRow(overrides: Partial<Row> = {}): Row {
  return {
    id: `cohort-${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: WS,
    meta_ad_account_id: null,
    test_meta_adset_id: "6100000000001",
    daily_test_ceiling_cents: 50000,
    is_active: true,
    ...overrides,
  };
}

const NOW = new Date("2026-07-08T13:00:00.000Z");

// ── Behaviour tests ─────────────────────────────────────────────────────────

test("dispatchMediaBuyerCadence — workspace-wide + per-account cohorts → 2 jobs, each with correct account", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [
      cohortRow({ meta_ad_account_id: null }),
      cohortRow({ meta_ad_account_id: ACCT_A }),
    ],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchMediaBuyerCadence(admin, WS, NOW);
  assert.equal(r.evaluated, 2);
  assert.equal(r.dispatched, 2);
  const jobs = tables.agent_jobs;
  assert.equal(jobs.length, 2);
  const accounts = jobs
    .map((j) => JSON.parse(String(j.instructions)).meta_ad_account_id)
    .sort();
  assert.deepEqual(accounts, [null, ACCT_A].sort());
  for (const j of jobs) {
    assert.equal(j.kind, "media-buyer");
    assert.equal(j.workspace_id, WS);
  }
});

test("dispatchMediaBuyerCadence — inactive cohort is IGNORED", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [cohortRow({ is_active: false, meta_ad_account_id: ACCT_A })],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchMediaBuyerCadence(admin, WS, NOW);
  assert.equal(r.evaluated, 0);
  assert.equal(r.dispatched, 0);
  assert.equal(tables.agent_jobs.length, 0);
});

test("dispatchMediaBuyerCadence — same-UTC-day second invocation dispatches ZERO new jobs (idempotency)", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [
      cohortRow({ meta_ad_account_id: null }),
      cohortRow({ meta_ad_account_id: ACCT_A }),
    ],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const first = await dispatchMediaBuyerCadence(admin, WS, NOW);
  assert.equal(first.dispatched, 2);
  const second = await dispatchMediaBuyerCadence(admin, WS, NOW);
  assert.equal(second.evaluated, 2);
  assert.equal(second.dispatched, 0);
  assert.equal(tables.agent_jobs.length, 2, "no duplicate rows added on same-day re-fire");
});

test("dispatchMediaBuyerCadence — a COMPLETED job from earlier today does NOT block a fresh dispatch (only unfinished jobs count)", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [cohortRow({ meta_ad_account_id: ACCT_A })],
    agent_jobs: [
      {
        id: "prior",
        workspace_id: WS,
        kind: "media-buyer",
        status: "completed",
        instructions: JSON.stringify({ meta_ad_account_id: ACCT_A }),
        created_at: "2026-07-08T00:30:00.000Z",
      },
    ],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchMediaBuyerCadence(admin, WS, NOW);
  assert.equal(r.dispatched, 1);
  assert.equal(tables.agent_jobs.length, 2);
});

test("dispatchMediaBuyerCadence — an UNFINISHED job from earlier today BLOCKS re-dispatch for that account only", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [
      cohortRow({ meta_ad_account_id: ACCT_A }),
      cohortRow({ meta_ad_account_id: ACCT_B }),
    ],
    agent_jobs: [
      {
        id: "in-flight",
        workspace_id: WS,
        kind: "media-buyer",
        status: "building",
        instructions: JSON.stringify({ meta_ad_account_id: ACCT_A }),
        created_at: "2026-07-08T04:00:00.000Z",
      },
    ],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchMediaBuyerCadence(admin, WS, NOW);
  assert.equal(r.dispatched, 1, "only the unclaimed account (B) dispatches");
  const inserted = tables.agent_jobs.filter((j) => j.id !== "in-flight");
  assert.equal(inserted.length, 1);
  assert.equal(
    JSON.parse(String(inserted[0].instructions)).meta_ad_account_id,
    ACCT_B,
  );
});

test("utcDayStartIso — floors a mid-day timestamp to 00:00:00Z of the same UTC day", () => {
  assert.equal(
    utcDayStartIso(new Date("2026-07-08T13:00:00Z")),
    "2026-07-08T00:00:00.000Z",
  );
  assert.equal(
    utcDayStartIso(new Date("2026-07-08T00:00:00Z")),
    "2026-07-08T00:00:00.000Z",
  );
});

test("ACTIVE_MEDIA_BUYER_JOB_STATUSES — includes the seven non-terminal states", () => {
  for (const s of [
    "queued",
    "claimed",
    "building",
    "needs_input",
    "needs_approval",
    "queued_resume",
    "blocked_on_usage",
  ]) {
    assert.ok(ACTIVE_MEDIA_BUYER_JOB_STATUSES.has(s), `missing "${s}"`);
  }
  for (const terminal of ["completed", "failed", "dismissed", "held", "needs_attention"]) {
    assert.ok(
      !ACTIVE_MEDIA_BUYER_JOB_STATUSES.has(terminal),
      `should NOT include terminal "${terminal}"`,
    );
  }
});
