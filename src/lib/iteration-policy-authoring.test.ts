/**
 * Unit tests for the iteration-policy-authoring Phase-3 spend-rail guard
 * (growth-adopt-meta-iteration-engine spec, Phase 3 — verification harness).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:iteration-policy-authoring
 *   (= tsx --test src/lib/iteration-policy-authoring.test.ts)
 *
 * Covers the two fixtures the spec verification names:
 *   1. A draft whose projected daily-delta motion × window_days would push current rolling spend
 *      past the workspace's `ad_spend_budgets` ceiling → guard REFUSES (allow=false, reason
 *      'ad_spend_ceiling_would_breach') with a structured diagnosis + refusal metadata.
 *   2. Same draft, no `ad_spend_budgets` row for the workspace → guard ALLOWS (no rail to breach).
 *
 * Mirrors `ad-spend-governor.test.ts`'s fake admin chain: a per-table chainable that matches simple
 * .eq/.gte/.lte/.is filters against an in-memory tables object and returns rows; .insert appends.
 * That's enough surface for getEffectiveAdSpendBudget + rollupAdSpendActual.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateActivationAgainstSpendRail } from "./iteration-policy-authoring";

// ── Fake admin client (the minimum chain getEffectiveAdSpendBudget + rollupAdSpendActual call) ─

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
      return {
        select: (...args: unknown[]) => makeChain(tables, table).select(...args),
        eq: (col: string, val: unknown) => makeChain(tables, table).eq(col, val),
        gte: (col: string, val: unknown) => makeChain(tables, table).gte(col, val),
        lte: (col: string, val: unknown) => makeChain(tables, table).lte(col, val),
        is: (col: string, val: unknown) => makeChain(tables, table).is(col, val),
        insert: async () => ({ data: null, error: null }),
      };
    },
  } as unknown as Parameters<typeof validateActivationAgainstSpendRail>[0];
}

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

test("validateActivationAgainstSpendRail — fixture whose projected motion would breach the ceiling REFUSES the activation", async () => {
  const t = today();
  const tables: Tables = {
    ad_spend_budgets: [
      {
        // $1,000 7-day ceiling, platform-wide
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
    daily_meta_ad_spend: [
      // Already running near the ceiling — $90/day for 8 days
      ...Array.from({ length: 8 }).map((_, i) => ({
        workspace_id: WS,
        meta_ad_account_id: ACCT,
        snapshot_date: shift(t, -i),
        spend_cents: 9000,
      })),
    ],
  };
  const admin = makeAdmin(tables);
  // Draft authorizes $50/day of additional daily motion. 50 × 7 = $350 added to ~$630 actual ⇒ $980;
  // we crank the daily delta to $100/day so 100 × 7 = $700 + $630 = $1,330 > $1,000 ceiling → breach.
  const decision = await validateActivationAgainstSpendRail(admin, {
    workspaceId: WS,
    draft: {
      per_account_daily_budget_delta_ceiling_cents: 10000, // $100/day
      scale_up_step_pct: 0.5,
    },
    metaAdAccountId: null,
    policyId: "policy-pending-1",
  });
  assert.equal(decision.allow, false);
  if (decision.allow) return; // type narrowing for TS
  assert.equal(decision.reason, "ad_spend_ceiling_would_breach");
  assert.ok(decision.diagnosis.length > 0, "expected a non-empty diagnosis");
  assert.match(decision.diagnosis, /breach/i);
  assert.equal(decision.metadata.policy_id, "policy-pending-1");
  assert.equal(decision.metadata.window_days, 7);
  assert.equal(decision.metadata.per_account_daily_budget_delta_ceiling_cents, 10000);
  assert.equal(decision.metadata.projected_window_delta_cents, 70000); // 10000 × 7
  assert.equal(decision.metadata.ceiling_cents, 100000);
  assert.equal(decision.metadata.platform, "meta");
});

test("validateActivationAgainstSpendRail — same draft, no ad_spend_budgets row, ALLOWS (no rail to breach)", async () => {
  const tables: Tables = {
    // Empty — no ceiling configured for this workspace.
    ad_spend_budgets: [],
    daily_meta_ad_spend: [],
  };
  const admin = makeAdmin(tables);
  const decision = await validateActivationAgainstSpendRail(admin, {
    workspaceId: WS,
    draft: {
      per_account_daily_budget_delta_ceiling_cents: 10000, // same $100/day knob as the breach fixture
      scale_up_step_pct: 0.5,
    },
    metaAdAccountId: null,
  });
  assert.equal(decision.allow, true);
  if (!decision.allow) return; // type narrowing
  assert.equal(decision.observation, null, "expected no observation when there's no rail");
});

test("validateActivationAgainstSpendRail — within-ceiling projection ALLOWS (with an observation snapshot)", async () => {
  const t = today();
  const tables: Tables = {
    ad_spend_budgets: [
      {
        id: "b1",
        workspace_id: WS,
        meta_ad_account_id: null,
        platform: "meta",
        window_days: 7,
        usd_ceiling_cents: 100000, // $1,000
        notes: null,
        updated_by: null,
        created_at: "",
        updated_at: "",
      },
    ],
    daily_meta_ad_spend: [
      // $10/day for 8 days → $70 actual in a 7d window
      ...Array.from({ length: 8 }).map((_, i) => ({
        workspace_id: WS,
        meta_ad_account_id: ACCT,
        snapshot_date: shift(t, -i),
        spend_cents: 1000,
      })),
    ],
  };
  const admin = makeAdmin(tables);
  // $50/day × 7d = $350 added to $70 actual → $420 ≤ $1,000 ⇒ allow.
  const decision = await validateActivationAgainstSpendRail(admin, {
    workspaceId: WS,
    draft: {
      per_account_daily_budget_delta_ceiling_cents: 5000,
      scale_up_step_pct: 0.15,
    },
    metaAdAccountId: null,
  });
  assert.equal(decision.allow, true);
  if (!decision.allow) return;
  assert.ok(decision.observation, "expected an observation snapshot when a rail is set");
  assert.equal(decision.observation!.projectedWindowDeltaCents, 35000);
  assert.equal(decision.observation!.ceilingCents, 100000);
});
