/**
 * Unit tests for the creative→outcome lineage attributor (growth-adopt-creative-makers Phase 3).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:creative-outcome-attribution
 *   (= tsx --test src/lib/ads/creative-outcome-attribution.test.ts)
 *
 * Covers the fixture the spec asks for plus the idempotency + maturation + no-attribution edges.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateAttributionRows,
  attributeCreativeOutcomes,
  ATTRIBUTED_CREATIVE_OUTCOME_KIND,
  PROMOTED_READY_TO_TEST_KIND,
} from "./creative-outcome-attribution";

// ── Fake admin client — supports both the chained `.select/.eq/.in/.gte/.lte` SELECT shape AND the
// `.insert({...})` write the recorder uses. Reads are answered out of a small per-table store; writes
// are appended to an `inserted` array so each test can assert against them. ───────────────────────
interface FakeStores {
  director_activity: Record<string, unknown>[];
  ad_publish_jobs: Record<string, unknown>[];
  meta_attribution_daily: Record<string, unknown>[];
}

interface QueryState {
  table: string;
  filters: { col: string; op: "eq" | "in" | "gte" | "lte"; val: unknown }[];
}

function rowMatches(row: Record<string, unknown>, filters: QueryState["filters"]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    if (f.op === "eq" && v !== f.val) return false;
    if (f.op === "in" && (!Array.isArray(f.val) || !(f.val as unknown[]).includes(v))) return false;
    if (f.op === "gte" && !(typeof v === "string" && typeof f.val === "string" && v >= f.val)) return false;
    if (f.op === "lte" && !(typeof v === "string" && typeof f.val === "string" && v <= f.val)) return false;
  }
  return true;
}

function makeChain(stores: FakeStores, table: string, inserted: { table: string; row: Record<string, unknown> }[]) {
  const state: QueryState = { table, filters: [] };
  let mode: "select" | "insert" = "select";
  let insertRow: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    state.filters.push({ col, op: "eq", val });
    return chain;
  };
  chain.in = (col: string, val: unknown) => {
    state.filters.push({ col, op: "in", val });
    return chain;
  };
  chain.gte = (col: string, val: unknown) => {
    state.filters.push({ col, op: "gte", val });
    return chain;
  };
  chain.lte = (col: string, val: unknown) => {
    state.filters.push({ col, op: "lte", val });
    return chain;
  };
  chain.insert = (row: Record<string, unknown>) => {
    mode = "insert";
    insertRow = row;
    return chain;
  };
  chain.then = (onFulfilled: (v: { data: unknown; error: null }) => unknown) => {
    if (mode === "insert") {
      inserted.push({ table, row: insertRow });
      return Promise.resolve({ data: null, error: null }).then(onFulfilled);
    }
    const rows = stores[table as keyof FakeStores] ?? [];
    const data = rows.filter((r) => rowMatches(r, state.filters));
    return Promise.resolve({ data, error: null }).then(onFulfilled);
  };
  return chain;
}

function makeAdmin(stores: FakeStores) {
  const inserted: { table: string; row: Record<string, unknown> }[] = [];
  const admin = {
    from(table: string) {
      return makeChain(stores, table, inserted);
    },
  } as unknown as Parameters<typeof attributeCreativeOutcomes>[0];
  return { admin, inserted, stores };
}

// ── aggregateAttributionRows — the pure summer ─────────────────────────────────

test("aggregateAttributionRows sums spend/sessions/revenue and picks the dominant named variant", () => {
  const out = aggregateAttributionRows([
    { variant: "advertorial", sessions: 80, attributed_spend_cents: 1000, revenue_cents: 4000, snapshot_date: "2026-06-25" },
    { variant: "advertorial", sessions: 20, attributed_spend_cents: 500, revenue_cents: 1000, snapshot_date: "2026-06-26" },
    { variant: "(unresolved)", sessions: 500, attributed_spend_cents: 0, revenue_cents: 0, snapshot_date: "2026-06-26" },
  ]);
  assert.equal(out.spend_cents, 1500);
  assert.equal(out.sessions, 600);
  assert.equal(out.roas, Number((5000 / 1500).toFixed(4)));
  // `(unresolved)` is excluded from the variant race when a named lander is present.
  assert.equal(out.variant_key, "advertorial");
});

test("aggregateAttributionRows returns null roas when spend is 0", () => {
  const out = aggregateAttributionRows([
    { variant: "beforeafter", sessions: 12, attributed_spend_cents: 0, revenue_cents: 0, snapshot_date: "2026-06-25" },
  ]);
  assert.equal(out.spend_cents, 0);
  assert.equal(out.roas, null);
  assert.equal(out.variant_key, "beforeafter");
});

test("aggregateAttributionRows falls back to `(unresolved)` only when there is no named variant", () => {
  const out = aggregateAttributionRows([
    { variant: "(unresolved)", sessions: 10, attributed_spend_cents: 100, revenue_cents: 0, snapshot_date: "2026-06-25" },
  ]);
  assert.equal(out.variant_key, "(unresolved)");
});

// ── attributeCreativeOutcomes — the end-to-end pass ────────────────────────────

test("a fixture publish job + a matched meta_attribution_daily row 4d later emits exactly one attributed_creative_outcome row", async () => {
  // Director promoted publish job J1 on 2026-06-24, the ad-tool published the row, and 4 days later
  // (snapshot 2026-06-28) the attribution table has one row keyed by the publish job's meta_ad_id.
  // Maturation is 3d, so 4d elapsed ⇒ the attributor writes one lineage row.
  const { admin, inserted } = makeAdmin({
    director_activity: [
      {
        workspace_id: "ws-1",
        action_kind: PROMOTED_READY_TO_TEST_KIND,
        spec_slug: "growth-adopt-creative-makers",
        metadata: { ad_publish_jobs_id: "J1" },
      },
    ],
    ad_publish_jobs: [
      {
        id: "J1",
        workspace_id: "ws-1",
        publish_status: "published",
        meta_ad_id: "120220000000000",
        meta_account_id: "act-acc-1",
        updated_at: "2026-06-24T18:00:00Z",
        created_at: "2026-06-24T17:00:00Z",
      },
    ],
    meta_attribution_daily: [
      {
        workspace_id: "ws-1",
        meta_ad_id: "120220000000000",
        variant: "advertorial",
        sessions: 50,
        attributed_spend_cents: 2000,
        revenue_cents: 6000,
        snapshot_date: "2026-06-27",
      },
    ],
  });

  const result = await attributeCreativeOutcomes(admin, {
    workspaceId: "ws-1",
    snapshotDate: "2026-06-28",
  });

  assert.equal(result.attributed, 1);
  assert.equal(result.skipped_immature, 0);
  assert.equal(result.skipped_already_done, 0);
  assert.equal(result.skipped_no_attribution, 0);
  assert.equal(result.skipped_not_published, 0);

  const lineageInserts = inserted.filter((i) => i.table === "director_activity");
  assert.equal(lineageInserts.length, 1);
  const row = lineageInserts[0].row;
  assert.equal(row["action_kind"], ATTRIBUTED_CREATIVE_OUTCOME_KIND);
  assert.equal(row["workspace_id"], "ws-1");
  assert.equal(row["director_function"], "growth");
  assert.equal(row["spec_slug"], "growth-adopt-creative-makers");
  const md = row["metadata"] as Record<string, unknown>;
  assert.equal(md["ad_publish_jobs_id"], "J1");
  assert.equal(md["meta_ad_id"], "120220000000000");
  assert.equal(md["attribution_window_days"], 7);
  const outcome = md["outcome"] as Record<string, unknown>;
  assert.equal(outcome["spend_cents"], 2000);
  assert.equal(outcome["sessions"], 50);
  assert.equal(outcome["roas"], Number((6000 / 2000).toFixed(4)));
  assert.equal(outcome["variant_key"], "advertorial");
});

test("a promotion whose publish hasn't matured (elapsed < OUTCOME_MATURATION_DAYS) is skipped", async () => {
  // Promoted on 2026-06-27, snapshot 2026-06-28 = 1d elapsed, maturation 3d ⇒ skip_immature.
  const { admin, inserted } = makeAdmin({
    director_activity: [
      {
        workspace_id: "ws-1",
        action_kind: PROMOTED_READY_TO_TEST_KIND,
        spec_slug: null,
        metadata: { ad_publish_jobs_id: "J2" },
      },
    ],
    ad_publish_jobs: [
      {
        id: "J2",
        workspace_id: "ws-1",
        publish_status: "published",
        meta_ad_id: "120220000000002",
        meta_account_id: "act-acc-1",
        updated_at: "2026-06-27T18:00:00Z",
        created_at: "2026-06-27T17:00:00Z",
      },
    ],
    meta_attribution_daily: [
      {
        workspace_id: "ws-1",
        meta_ad_id: "120220000000002",
        variant: "advertorial",
        sessions: 5,
        attributed_spend_cents: 100,
        revenue_cents: 0,
        snapshot_date: "2026-06-27",
      },
    ],
  });
  const result = await attributeCreativeOutcomes(admin, {
    workspaceId: "ws-1",
    snapshotDate: "2026-06-28",
  });
  assert.equal(result.attributed, 0);
  assert.equal(result.skipped_immature, 1);
  assert.equal(inserted.filter((i) => i.table === "director_activity").length, 0);
});

test("a publish job already has an attributed_creative_outcome row ⇒ skip_already_done (idempotent)", async () => {
  // The same publish job carries BOTH a promoted_ready_to_test row AND a settled attributed row from a
  // prior pass. The attributor must NOT write a second row — that's the idempotency guarantee that
  // makes the daily heartbeat safe.
  const { admin, inserted } = makeAdmin({
    director_activity: [
      {
        workspace_id: "ws-1",
        action_kind: PROMOTED_READY_TO_TEST_KIND,
        spec_slug: null,
        metadata: { ad_publish_jobs_id: "J3" },
      },
      {
        workspace_id: "ws-1",
        action_kind: ATTRIBUTED_CREATIVE_OUTCOME_KIND,
        spec_slug: null,
        metadata: { ad_publish_jobs_id: "J3", outcome: { roas: 2.1, spend_cents: 1000, sessions: 40, variant_key: "advertorial" } },
      },
    ],
    ad_publish_jobs: [
      {
        id: "J3",
        workspace_id: "ws-1",
        publish_status: "published",
        meta_ad_id: "120220000000003",
        meta_account_id: "act-acc-1",
        updated_at: "2026-06-20T18:00:00Z",
        created_at: "2026-06-20T17:00:00Z",
      },
    ],
    meta_attribution_daily: [
      {
        workspace_id: "ws-1",
        meta_ad_id: "120220000000003",
        variant: "advertorial",
        sessions: 40,
        attributed_spend_cents: 1000,
        revenue_cents: 2100,
        snapshot_date: "2026-06-26",
      },
    ],
  });
  const result = await attributeCreativeOutcomes(admin, {
    workspaceId: "ws-1",
    snapshotDate: "2026-06-28",
  });
  assert.equal(result.attributed, 0);
  assert.equal(result.skipped_already_done, 1);
  assert.equal(inserted.filter((i) => i.table === "director_activity").length, 0);
});

test("a publish job that hasn't reached publish_status='published' is skipped", async () => {
  // J4's job row exists but is still `creating` — no meta_ad_id to key attribution off. Skip.
  const { admin, inserted } = makeAdmin({
    director_activity: [
      {
        workspace_id: "ws-1",
        action_kind: PROMOTED_READY_TO_TEST_KIND,
        spec_slug: null,
        metadata: { ad_publish_jobs_id: "J4" },
      },
    ],
    ad_publish_jobs: [
      {
        id: "J4",
        workspace_id: "ws-1",
        publish_status: "creating",
        meta_ad_id: null,
        meta_account_id: "act-acc-1",
        updated_at: "2026-06-20T18:00:00Z",
        created_at: "2026-06-20T17:00:00Z",
      },
    ],
    meta_attribution_daily: [],
  });
  const result = await attributeCreativeOutcomes(admin, {
    workspaceId: "ws-1",
    snapshotDate: "2026-06-28",
  });
  assert.equal(result.attributed, 0);
  assert.equal(result.skipped_not_published, 1);
  assert.equal(inserted.filter((i) => i.table === "director_activity").length, 0);
});

test("a mature promotion with no attribution rows for its meta_ad_id is skipped (no signal yet)", async () => {
  // J5 published 7d ago but the attribution table has nothing keyed to its meta_ad_id (e.g. zero
  // delivery). Don't write a fake outcome row — the spec only stamps when there's signal.
  const { admin, inserted } = makeAdmin({
    director_activity: [
      {
        workspace_id: "ws-1",
        action_kind: PROMOTED_READY_TO_TEST_KIND,
        spec_slug: null,
        metadata: { ad_publish_jobs_id: "J5" },
      },
    ],
    ad_publish_jobs: [
      {
        id: "J5",
        workspace_id: "ws-1",
        publish_status: "published",
        meta_ad_id: "120220000000005",
        meta_account_id: "act-acc-1",
        updated_at: "2026-06-20T18:00:00Z",
        created_at: "2026-06-20T17:00:00Z",
      },
    ],
    meta_attribution_daily: [
      // a row for a DIFFERENT meta_ad_id — should not match J5
      {
        workspace_id: "ws-1",
        meta_ad_id: "120220000099999",
        variant: "advertorial",
        sessions: 10,
        attributed_spend_cents: 100,
        revenue_cents: 200,
        snapshot_date: "2026-06-22",
      },
    ],
  });
  const result = await attributeCreativeOutcomes(admin, {
    workspaceId: "ws-1",
    snapshotDate: "2026-06-28",
  });
  assert.equal(result.attributed, 0);
  assert.equal(result.skipped_no_attribution, 1);
  assert.equal(inserted.filter((i) => i.table === "director_activity").length, 0);
});
