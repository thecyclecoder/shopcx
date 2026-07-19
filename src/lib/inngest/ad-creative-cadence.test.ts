/**
 * Unit tests for the per-workspace ad-creative-cadence sweep — the pure
 * `dispatchAdCreativeCadence` helper the Inngest handler wraps. Focused
 * regression coverage for the `spec_slug` NOT NULL insert boundary (the
 * 2026-07-12 outage — Control Tower signature `vercel:731cb5703f5f40b6`)
 * plus the surrounding bin-floor / idempotency shape.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/ad-creative-cadence.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  adCreativeSpecSlug,
  dispatchAdCreativeCadence,
} from "./ad-creative-cadence";

// ── Fake admin client (shape mirrors media-buyer-cadence.test.ts) ────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Filter {
  kind: "eq" | "gte" | "in";
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
    if (f.kind === "in" && !(Array.isArray(f.val) && f.val.includes(v))) {
      return false;
    }
  }
  return true;
}

interface FakeChain {
  select: (...args: unknown[]) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  gte: (col: string, val: unknown) => FakeChain;
  in: (col: string, val: unknown[]) => FakeChain;
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
    in: (col, val) => {
      filters.push({ kind: "in", col, val });
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
        in: (col: string, val: unknown[]) => makeChain(tables, table).in(col, val),
        insert: async (row: Row | Row[]) => {
          const arr = tables[table] ?? (tables[table] = []);
          const now = "2026-07-12T11:00:00.000Z";
          const asRow = (r: Row): Row => {
            // Simulate the DB NOT NULL constraint on spec_slug — the exact insert
            // failure Vercel signature `vercel:731cb5703f5f40b6` captured.
            if (table === "agent_jobs") {
              const slug = r.spec_slug;
              if (typeof slug !== "string" || slug.length === 0) {
                return { ...r }; // will be reported via error below
              }
            }
            return {
              id: `job-${arr.length + 1}`,
              status: "queued",
              created_at: now,
              ...r,
            };
          };
          if (table === "agent_jobs") {
            const rows = Array.isArray(row) ? row : [row];
            for (const r of rows) {
              const slug = (r as Row).spec_slug;
              if (typeof slug !== "string" || slug.length === 0) {
                return {
                  data: null,
                  error: {
                    message:
                      'null value in column "spec_slug" of relation "agent_jobs" violates not-null constraint',
                  },
                };
              }
            }
            for (const r of rows) arr.push(asRow(r));
            return { data: null, error: null };
          }
          if (Array.isArray(row)) arr.push(...row.map(asRow));
          else arr.push(asRow(row));
          return { data: null, error: null };
        },
      };
    },
  } as unknown as Parameters<typeof dispatchAdCreativeCadence>[0];
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const WS = "ws-1";
const PRODUCT_A = "61a4490e-cb2a-4f65-9613-faab40f0b153"; // the outage product id
const PRODUCT_B = "b0000000-0000-0000-0000-000000000000";
const NOW = new Date("2026-07-12T11:00:00.000Z");

// ── Behaviour tests ─────────────────────────────────────────────────────────

test("adCreativeSpecSlug — deterministic, product-scoped, non-empty", () => {
  assert.equal(adCreativeSpecSlug(PRODUCT_A), `ad-creative:${PRODUCT_A}`);
  assert.equal(adCreativeSpecSlug(PRODUCT_A), adCreativeSpecSlug(PRODUCT_A));
  assert.notEqual(adCreativeSpecSlug(PRODUCT_A), adCreativeSpecSlug(PRODUCT_B));
  assert.ok(adCreativeSpecSlug(PRODUCT_A).length > 0);
});

test("dispatchAdCreativeCadence — every dispatched job carries a non-empty product-scoped spec_slug", async () => {
  const tables: Tables = {
    product_ad_angles: [
      { workspace_id: WS, product_id: PRODUCT_A },
      { workspace_id: WS, product_id: PRODUCT_B },
    ],
    ad_campaigns: [],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchAdCreativeCadence(admin, WS, 3, NOW);
  assert.equal(r.evaluated, 2);
  assert.equal(r.dispatched, 2);
  const jobs = tables.agent_jobs;
  assert.equal(jobs.length, 2, "both below-floor products dispatched");
  const slugByProduct = new Map(
    jobs.map((j) => [
      JSON.parse(String(j.instructions)).product_id as string,
      j.spec_slug as unknown,
    ]),
  );
  for (const productId of [PRODUCT_A, PRODUCT_B]) {
    const slug = slugByProduct.get(productId);
    assert.ok(
      typeof slug === "string" && slug.length > 0,
      `spec_slug must be a non-empty string (NOT NULL column) for product ${productId} — got ${String(slug)}`,
    );
    assert.equal(slug, `ad-creative:${productId}`);
  }
  for (const j of jobs) {
    assert.equal(j.kind, "ad-creative");
    assert.equal(j.workspace_id, WS);
  }
});

test("dispatchAdCreativeCadence — the outage product (Vercel signature vercel:731cb5703f5f40b6) now inserts cleanly", async () => {
  const tables: Tables = {
    product_ad_angles: [{ workspace_id: WS, product_id: PRODUCT_A }],
    ad_campaigns: [],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchAdCreativeCadence(admin, WS, 3, NOW);
  assert.equal(r.dispatched, 1, "the outage product dispatches instead of failing");
  const [job] = tables.agent_jobs;
  assert.equal(job.spec_slug, `ad-creative:${PRODUCT_A}`);
  assert.equal(job.kind, "ad-creative");
});

test("dispatchAdCreativeCadence — same-UTC-day second invocation dispatches ZERO new jobs (idempotency)", async () => {
  const tables: Tables = {
    product_ad_angles: [
      { workspace_id: WS, product_id: PRODUCT_A },
      { workspace_id: WS, product_id: PRODUCT_B },
    ],
    ad_campaigns: [],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const first = await dispatchAdCreativeCadence(admin, WS, 3, NOW);
  assert.equal(first.dispatched, 2);
  const second = await dispatchAdCreativeCadence(admin, WS, 3, NOW);
  assert.equal(second.evaluated, 2);
  assert.equal(second.dispatched, 0);
  assert.equal(tables.agent_jobs.length, 2, "no duplicate rows added on same-day re-fire");
});

test("dispatchAdCreativeCadence — no products with ad intelligence → no-op", async () => {
  const tables: Tables = {
    product_ad_angles: [],
    ad_campaigns: [],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchAdCreativeCadence(admin, WS, 3, NOW);
  assert.equal(r.evaluated, 0);
  assert.equal(r.dispatched, 0);
  assert.equal(tables.agent_jobs.length, 0);
});

// ── ad-creative-box-session-only-retire-deterministic-path Phase 3 (2026-07-19) ──
// Freeze = produce nothing. When the resolved effective switch for `ad-creative` is OFF,
// the cadence enqueues ZERO jobs even for below-floor products — no queued row lands, so
// the box worker cannot claim (defence-in-depth on the claim RPC's cascade). Injecting
// the resolver keeps the test pure (no live registry/DB).

test("dispatchAdCreativeCadence — ad-creative kill switch OFF → zero enqueued (freeze = produce nothing)", async () => {
  const tables: Tables = {
    product_ad_angles: [
      { workspace_id: WS, product_id: PRODUCT_A },
      { workspace_id: WS, product_id: PRODUCT_B },
    ],
    ad_campaigns: [], // both products at bin depth 0 — well below the floor
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchAdCreativeCadence(admin, WS, 3, NOW, {
    resolveSwitch: async (nodeId) => {
      assert.equal(nodeId, "ad-creative", "cadence must consult the ad-creative agent-kind node");
      return { off: true, offBy: "ad-creative", scope: "agent", reason: "manual e2e freeze" };
    },
  });
  assert.equal(r.evaluated, 0, "no products evaluated when the switch is off");
  assert.equal(r.dispatched, 0, "no jobs dispatched when the switch is off");
  assert.deepEqual(r.killSwitchOff, { offBy: "ad-creative", scope: "agent", reason: "manual e2e freeze" });
  assert.equal(tables.agent_jobs.length, 0, "zero rows landed in agent_jobs");
});

test("dispatchAdCreativeCadence — ad-creative kill switch ON → dispatches normally (baseline)", async () => {
  const tables: Tables = {
    product_ad_angles: [{ workspace_id: WS, product_id: PRODUCT_A }],
    ad_campaigns: [],
    agent_jobs: [],
  };
  const admin = makeAdmin(tables);
  const r = await dispatchAdCreativeCadence(admin, WS, 3, NOW, {
    resolveSwitch: async () => ({ off: false }),
  });
  assert.equal(r.dispatched, 1, "switch on ⇒ normal dispatch");
  assert.equal(r.killSwitchOff, undefined);
});
