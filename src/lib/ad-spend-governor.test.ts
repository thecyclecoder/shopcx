/**
 * Unit tests for ad-spend-governor (growth-ad-spend-rail Phase 2 — verification harness).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:ad-spend-governor
 *   (= tsx --test src/lib/ad-spend-governor.test.ts)
 *
 * Covers the two verification fixtures from the spec:
 *   - under-ceiling spend emits zero escalations
 *   - over-ceiling spend for two consecutive days emits exactly one escalation row
 * Plus the per-account-beats-platform-wide effective-budget rule.
 *
 * The fake admin client routes per-table .from(...) calls through a chainable that
 * matches filter chains against an in-memory table and returns rows; inserts append
 * to that table. That gives us enough surface for `runAdSpendGovernorPass` (which
 * reads ad_spend_budgets + daily_meta_ad_spend, dedupe-checks dashboard_notifications,
 * and inserts dashboard_notifications + director_activity).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getEffectiveAdSpendBudget,
  rollupAdSpendActual,
  runAdSpendGovernorPass,
} from "./ad-spend-governor";

// ── Fake admin client ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Filter {
  kind: "eq" | "gte" | "lte" | "is";
  col: string;
  val: unknown;
}

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    if (f.kind === "eq" && v !== f.val) return false;
    if (f.kind === "gte" && !(typeof v === "string" && typeof f.val === "string" && v >= f.val)) return false;
    if (f.kind === "lte" && !(typeof v === "string" && typeof f.val === "string" && v <= f.val)) return false;
    if (f.kind === "is" && f.val === null && v !== null && v !== undefined) return false;
  }
  return true;
}

interface FakeChain {
  select: (...args: unknown[]) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  gte: (col: string, val: unknown) => FakeChain;
  lte: (col: string, val: unknown) => FakeChain;
  is: (col: string, val: unknown) => FakeChain;
  order: (...args: unknown[]) => FakeChain;
  limit: (n: number) => FakeChain;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  then: (onFulfilled: (v: { data: Row[]; error: null }) => unknown) => Promise<unknown>;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  let limitN: number | null = null;
  const resolve = () => {
    const all = tables[table] ?? [];
    let rows = all.filter((r) => matches(r, filters));
    if (limitN != null) rows = rows.slice(0, limitN);
    return { data: rows, error: null as null };
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
    lte: (col, val) => {
      filters.push({ kind: "lte", col, val });
      return chain;
    },
    is: (col, val) => {
      filters.push({ kind: "is", col, val });
      return chain;
    },
    order: () => chain,
    limit: (n) => {
      limitN = n;
      return chain;
    },
    maybeSingle: async () => {
      const r = resolve();
      return { data: r.data[0] ?? null, error: null };
    },
    then: (onFulfilled) => Promise.resolve(resolve()).then(onFulfilled),
  };
  return chain;
}

function makeAdmin(tables: Tables) {
  return {
    from(table: string) {
      // .insert is its own terminal — doesn't share filter state.
      return {
        select: (...args: unknown[]) => makeChain(tables, table).select(...args),
        eq: (col: string, val: unknown) => makeChain(tables, table).eq(col, val),
        gte: (col: string, val: unknown) => makeChain(tables, table).gte(col, val),
        lte: (col: string, val: unknown) => makeChain(tables, table).lte(col, val),
        is: (col: string, val: unknown) => makeChain(tables, table).is(col, val),
        insert: async (row: Row | Row[]) => {
          const arr = tables[table] ?? (tables[table] = []);
          if (Array.isArray(row)) arr.push(...row);
          else arr.push(row);
          return { data: null, error: null };
        },
      };
    },
  } as unknown as Parameters<typeof runAdSpendGovernorPass>[0];
}

// Helpers for building snapshot dates aligned with the governor's UTC-today / yesterday windows.
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function shift(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

const WS = "ws-1";
const ACCT = "acct-A";

// ── Tests ────────────────────────────────────────────────────────────────────────────

test("getEffectiveAdSpendBudget — per-account row beats the platform-wide row for the same workspace+platform", async () => {
  const admin = makeAdmin({
    ad_spend_budgets: [
      {
        id: "b-platform",
        workspace_id: WS,
        meta_ad_account_id: null,
        platform: "meta",
        window_days: 7,
        usd_ceiling_cents: 100000,
        notes: null,
        updated_by: null,
        created_at: "",
        updated_at: "",
      },
      {
        id: "b-account",
        workspace_id: WS,
        meta_ad_account_id: ACCT,
        platform: "meta",
        window_days: 7,
        usd_ceiling_cents: 50000,
        notes: null,
        updated_by: null,
        created_at: "",
        updated_at: "",
      },
    ],
  });
  const exact = await getEffectiveAdSpendBudget(admin, WS, { platform: "meta", metaAdAccountId: ACCT });
  assert.equal(exact?.id, "b-account");
  const wide = await getEffectiveAdSpendBudget(admin, WS, { platform: "meta", metaAdAccountId: null });
  assert.equal(wide?.id, "b-platform");
  const missing = await getEffectiveAdSpendBudget(admin, WS, { platform: "google" });
  assert.equal(missing, null);
});

test("rollupAdSpendActual — google/amazon platforms return 0 (Meta-only spend table)", async () => {
  const admin = makeAdmin({});
  const r = await rollupAdSpendActual(admin, { workspaceId: WS, platform: "google", windowDays: 7 });
  assert.equal(r.actualCents, 0);
  assert.equal(r.windowDays, 7);
});

test("runAdSpendGovernorPass — under-ceiling fixture emits zero escalations", async () => {
  const t = today();
  const tables: Tables = {
    ad_spend_budgets: [
      {
        id: "b1",
        workspace_id: WS,
        meta_ad_account_id: null,
        platform: "meta",
        window_days: 7,
        usd_ceiling_cents: 100000, // $1,000 ceiling
        notes: null,
        updated_by: null,
        created_at: "",
        updated_at: "",
      },
    ],
    daily_meta_ad_spend: [
      // Way under ceiling — $50/day for 8 days (covers today + yesterday's 7d windows).
      ...Array.from({ length: 8 }).map((_, i) => ({
        workspace_id: WS,
        meta_ad_account_id: ACCT,
        snapshot_date: shift(t, -i),
        spend_cents: 5000,
      })),
    ],
    dashboard_notifications: [],
    director_activity: [],
  };
  const admin = makeAdmin(tables);
  const r = await runAdSpendGovernorPass(admin);
  assert.equal(r.observed, 1);
  assert.equal(r.escalations, 0);
  assert.equal(r.observations[0].trendOver, false);
  assert.equal((tables.dashboard_notifications ?? []).length, 0);
  assert.equal((tables.director_activity ?? []).length, 0);
});

test("runAdSpendGovernorPass — fixture over the ceiling for 2 consecutive days emits exactly one escalation row", async () => {
  const t = today();
  const tables: Tables = {
    ad_spend_budgets: [
      {
        id: "b1",
        workspace_id: WS,
        meta_ad_account_id: null,
        platform: "meta",
        window_days: 7,
        usd_ceiling_cents: 100000, // $1,000 ceiling
        notes: null,
        updated_by: null,
        created_at: "",
        updated_at: "",
      },
    ],
    daily_meta_ad_spend: [
      // $200/day for the last 8 days → today's 7d window = $1,400; yesterday's 7d window = $1,400.
      // Both over the $1,000 ceiling → 2-day rolling-above trend → one escalation.
      ...Array.from({ length: 8 }).map((_, i) => ({
        workspace_id: WS,
        meta_ad_account_id: ACCT,
        snapshot_date: shift(t, -i),
        spend_cents: 20000,
      })),
    ],
    dashboard_notifications: [],
    director_activity: [],
  };
  const admin = makeAdmin(tables);
  const r = await runAdSpendGovernorPass(admin);
  assert.equal(r.observed, 1);
  assert.equal(r.escalations, 1);
  assert.equal(r.observations[0].trendOver, true);
  assert.equal(r.observations[0].currentOver, true);
  assert.equal(r.observations[0].priorOver, true);

  // One CEO-routed approval-request notification, one growth director_activity row.
  const notifs = tables.dashboard_notifications ?? [];
  assert.equal(notifs.length, 1);
  const meta = (notifs[0].metadata ?? {}) as Record<string, unknown>;
  assert.equal(meta.escalation_kind, "ad_spend_ceiling");
  assert.equal(meta.dedupe_key, `ad_spend_ceiling:${WS}:meta:all`);

  const activity = tables.director_activity ?? [];
  // platform-director.escalateDiagnosisToCeo writes its OWN 'platform'/'escalated' row before
  // returning; the governor then writes a 'growth'/'escalated_ad_spend_ceiling' row. Both expected.
  assert.equal(activity.length, 2);
  const growthRow = activity.find((r) => r.director_function === "growth");
  assert.ok(growthRow, "expected a growth-owned director_activity row");
  assert.equal(growthRow!.action_kind, "escalated_ad_spend_ceiling");
  const growthMeta = (growthRow!.metadata ?? {}) as Record<string, unknown>;
  assert.equal(growthMeta.platform, "meta");
  assert.equal(growthMeta.meta_ad_account_id, null);
  assert.equal(growthMeta.window_days, 7);
  assert.equal(growthMeta.ceiling_cents, 100000);
  assert.equal(growthMeta.actual_cents, 140000); // $1,400 over the 7d window
});

test("runAdSpendGovernorPass — only the latest day above ceiling (no 2-day trend) does NOT escalate", async () => {
  const t = today();
  const tables: Tables = {
    ad_spend_budgets: [
      {
        id: "b1",
        workspace_id: WS,
        meta_ad_account_id: null,
        platform: "meta",
        window_days: 7,
        usd_ceiling_cents: 100000,
        notes: null,
        updated_by: null,
        created_at: "",
        updated_at: "",
      },
    ],
    // Today's 7d window = $1,200 (over), but yesterday's 7d window = $700 (under) — no 2-day trend.
    // Achieve this with one big spike today and small spend before: today $1,200, then $100/day prior.
    daily_meta_ad_spend: [
      { workspace_id: WS, meta_ad_account_id: ACCT, snapshot_date: t, spend_cents: 120000 }, // $1,200 today
      ...Array.from({ length: 7 }).map((_, i) => ({
        workspace_id: WS,
        meta_ad_account_id: ACCT,
        snapshot_date: shift(t, -(i + 1)),
        spend_cents: 10000, // $100/day prior 7 days
      })),
    ],
    dashboard_notifications: [],
    director_activity: [],
  };
  const admin = makeAdmin(tables);
  const r = await runAdSpendGovernorPass(admin);
  assert.equal(r.escalations, 0);
  assert.equal(r.observations[0].currentOver, true);
  assert.equal(r.observations[0].priorOver, false);
  assert.equal(r.observations[0].trendOver, false);
});
