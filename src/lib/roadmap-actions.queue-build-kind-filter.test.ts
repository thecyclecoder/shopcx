/**
 * fix-queue-roadmap-build-kind-filter Phase 1 + Phase 2.
 *
 * Phase 1 — the existing-job guard inside `queueRoadmapBuild` must filter by `kind='build'`. Pins
 * the named failing state from the spec: a live Mario job (kind='mario', status='building') for
 * slug X, and no live BUILD for X, must NOT be treated as the existing active build — the fresh
 * enqueue must fall through and insert a NEW kind='build' row. Otherwise Mario's
 * `reclaim_and_redrive` coalesces into the very job that is INVOKING it and the reclaim silently
 * drops (the sol-reads-moved ~19h stall).
 *
 * Phase 2 — regression test at the Mario boundary. `reclaimAndRedrive(admin, W, X)` from a live
 * Mario job actually enqueues a fresh kind='build' row (positive), and NEVER double-inserts when
 * a live build is already present (negative). This is the boundary the Phase-1 filter unblocks —
 * without the filter, reclaimAndRedrive was a no-op that returned {alreadyActive:true} on the
 * Mario job it was invoked FROM.
 *
 * Stubs the Supabase admin client + the brain-roadmap + specs-table dependencies via Node's
 * module cache BEFORE dynamic-importing roadmap-actions + mario.
 *
 * Run:
 *   npx tsx --test src/lib/roadmap-actions.queue-build-kind-filter.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_ID = "22222222-2222-2222-2222-222222222222";
const SPEC_SLUG = "sol-reads-moved-as-address-update";

interface AgentJobRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  kind: string;
  status: string;
  instructions?: string | null;
  created_by?: string | null;
  created_at: string;
  chain_phases?: boolean;
}

interface World {
  agentJobs: AgentJobRow[];
  nextId: number;
}

const world: World = { agentJobs: [], nextId: 1 };

function resetWorld() {
  world.agentJobs = [];
  world.nextId = 1;
}

interface QueryBuilder {
  select(cols?: string): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  in(col: string, vals: unknown[]): QueryBuilder;
  neq(col: string, val: unknown): QueryBuilder;
  order(col: string, opts?: unknown): QueryBuilder;
  limit(n: number): QueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  single(): Promise<{ data: unknown; error: null }>;
  insert(row: Record<string, unknown>): QueryBuilder;
}

function makeFrom(table: string): QueryBuilder {
  const filters: Record<string, unknown> = {};
  const inFilters: Record<string, unknown[]> = {};
  const neqFilters: Record<string, unknown> = {};
  let insertedRow: Record<string, unknown> | null = null;

  function resolve(): unknown[] {
    if (table === "workspace_members") {
      // assertOwner reads (workspace_id, user_id) → returns { role: 'owner' }.
      if (filters.workspace_id === WORKSPACE_ID && filters.user_id === OWNER_ID) {
        return [{ role: "owner" }];
      }
      // reclaimAndRedrive reads (workspace_id, role='owner') → returns { user_id }.
      if (filters.workspace_id === WORKSPACE_ID && filters.role === "owner") {
        return [{ user_id: OWNER_ID }];
      }
      return [];
    }
    if (table === "agent_jobs") {
      let rows = world.agentJobs.slice();
      const asRec = (r: AgentJobRow): Record<string, unknown> => r as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(filters)) rows = rows.filter((r) => asRec(r)[k] === v);
      for (const [k, vs] of Object.entries(inFilters)) rows = rows.filter((r) => vs.includes(asRec(r)[k]));
      for (const [k, v] of Object.entries(neqFilters)) rows = rows.filter((r) => asRec(r)[k] !== v);
      // .order created_at desc
      rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
      return rows;
    }
    // Empty for every other table (specs, spec_phases, goal_milestones, goals) — makes null-fallback branches fire.
    return [];
  }

  const builder: QueryBuilder = {
    select() {
      return builder;
    },
    eq(col, val) {
      filters[col] = val;
      return builder;
    },
    in(col, vals) {
      inFilters[col] = vals;
      return builder;
    },
    neq(col, val) {
      neqFilters[col] = val;
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    async maybeSingle() {
      const r = resolve();
      return { data: r[0] ?? null, error: null };
    },
    async single() {
      if (insertedRow) {
        return { data: insertedRow, error: null };
      }
      const r = resolve();
      return { data: r[0] ?? null, error: null };
    },
    insert(row) {
      if (table === "agent_jobs") {
        const newRow: AgentJobRow = {
          id: `job-${world.nextId++}`,
          workspace_id: String(row.workspace_id),
          spec_slug: String(row.spec_slug),
          kind: (row.kind as string) ?? "build",
          status: (row.status as string) ?? "queued",
          instructions: (row.instructions as string | null) ?? null,
          created_by: (row.created_by as string | null) ?? null,
          created_at: new Date(2026, 6, 9, 12, world.nextId).toISOString(),
          chain_phases: (row.chain_phases as boolean | undefined) ?? false,
        };
        world.agentJobs.push(newRow);
        insertedRow = newRow as unknown as Record<string, unknown>;
      }
      return builder;
    },
  };
  return builder;
}

const stubAdmin = {
  from(table: string) {
    return makeFrom(table);
  },
  rpc: async () => ({ data: null, error: null }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};
moduleAny._cache[require.resolve("@/lib/brain-roadmap")] = {
  exports: {
    getSpec: async () => null,
    getSpecBlockers: async () => [],
    phaseEmoji: (p: string) => p,
  },
};
moduleAny._cache[require.resolve("@/lib/specs-table")] = {
  exports: {
    getSpec: async () => null,
    // Anything else agent-jobs.ts pulls off specs-table when the goal path is exercised — but our
    // stub above ensures resolveGoalSlugForSpec returns null before those calls fire.
    goalBranchState: async () => ({ specs: [] }),
    stampPhaseShipped: async () => undefined,
    stampSpecMergeProvenance: async () => undefined,
    isSpecAccumulationComplete: async () => false,
  },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { queueRoadmapBuild } = require("@/lib/roadmap-actions") as typeof import("./roadmap-actions");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reclaimAndRedrive } = require("@/lib/mario") as typeof import("./mario");

// ── Tests ───────────────────────────────────────────────────────────────────

test("named failing state: a live Mario job for slug X does NOT block a fresh kind='build' enqueue", async () => {
  resetWorld();
  world.agentJobs.push({
    id: "mario-1",
    workspace_id: WORKSPACE_ID,
    spec_slug: SPEC_SLUG,
    kind: "mario",
    status: "building",
    created_at: "2026-07-09T12:00:00Z",
  });

  const result = await queueRoadmapBuild(WORKSPACE_ID, OWNER_ID, { slug: SPEC_SLUG });

  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  if (!result.ok) return;
  assert.equal(result.alreadyActive, undefined, "must NOT be alreadyActive — the Mario job is not a live build");
  assert.equal(result.job.kind, "build", "the inserted row must be kind='build'");
  const inserted = world.agentJobs.filter((r) => r.kind === "build");
  assert.equal(inserted.length, 1, "exactly one fresh build row was inserted");
});

test("unchanged: a live kind='build' job still coalesces a plain Build tap into alreadyActive", async () => {
  resetWorld();
  world.agentJobs.push({
    id: "build-1",
    workspace_id: WORKSPACE_ID,
    spec_slug: SPEC_SLUG,
    kind: "build",
    status: "building",
    created_at: "2026-07-09T12:00:00Z",
  });

  const result = await queueRoadmapBuild(WORKSPACE_ID, OWNER_ID, { slug: SPEC_SLUG });

  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  if (!result.ok) return;
  assert.equal(result.alreadyActive, true, "the live build coalesces the plain tap — unchanged behavior");
  const builds = world.agentJobs.filter((r) => r.kind === "build");
  assert.equal(builds.length, 1, "no second build row was inserted");
});

test("unchanged: a live kind='build' + instructions still enqueues a distinct follow-up build", async () => {
  resetWorld();
  world.agentJobs.push({
    id: "build-1",
    workspace_id: WORKSPACE_ID,
    spec_slug: SPEC_SLUG,
    kind: "build",
    status: "building",
    created_at: "2026-07-09T12:00:00Z",
  });

  const result = await queueRoadmapBuild(WORKSPACE_ID, OWNER_ID, {
    slug: SPEC_SLUG,
    instructions: "fix the retry logic",
  });

  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  if (!result.ok) return;
  assert.equal(result.queuedBehindActive, true, "the new instructions carve a follow-up build — unchanged behavior");
  const builds = world.agentJobs.filter((r) => r.kind === "build");
  assert.equal(builds.length, 2, "the follow-up build was inserted alongside the live one");
});

// ── Phase 2: Mario boundary — reclaim_and_redrive INTO queueRoadmapBuild ─────

test("mario boundary — positive: reclaimAndRedrive with a live Mario job and NO build inserts a queued kind='build' row", async () => {
  resetWorld();
  // The named failing state: the mario_fixed director_activity fired reclaim_and_redrive from
  // the RUNNING Mario job itself. Under the pre-fix guard, queueRoadmapBuild matched that Mario
  // row and returned {alreadyActive:true} — a silent no-op. Under the Phase-1 fix, the guard is
  // scoped to kind='build' so this Mario row is invisible and a fresh build lands.
  world.agentJobs.push({
    id: "mario-1",
    workspace_id: WORKSPACE_ID,
    spec_slug: SPEC_SLUG,
    kind: "mario",
    status: "building",
    created_at: "2026-07-09T12:00:00Z",
  });

  await reclaimAndRedrive(stubAdmin as never, WORKSPACE_ID, SPEC_SLUG);

  const builds = world.agentJobs.filter((r) => r.kind === "build");
  assert.equal(builds.length, 1, "reclaimAndRedrive must insert exactly one fresh build row");
  assert.equal(builds[0].workspace_id, WORKSPACE_ID);
  assert.equal(builds[0].spec_slug, SPEC_SLUG);
  assert.equal(builds[0].status, "queued", "the reclaim's fresh build lands as queued");
  assert.equal(builds[0].created_by, OWNER_ID, "queueRoadmapBuild attributes the enqueue to the workspace owner");
});

test("mario boundary — negative: reclaimAndRedrive with a live BUILD already present does NOT double-insert", async () => {
  // The coalesce still fires for the legit case — a build IS live, so reclaim rides it and does
  // not carve a second row. This is unchanged Phase-1 behavior (the `alreadyActive` branch).
  resetWorld();
  world.agentJobs.push({
    id: "build-1",
    workspace_id: WORKSPACE_ID,
    spec_slug: SPEC_SLUG,
    kind: "build",
    status: "building",
    created_at: "2026-07-09T12:00:00Z",
  });

  await reclaimAndRedrive(stubAdmin as never, WORKSPACE_ID, SPEC_SLUG);

  const builds = world.agentJobs.filter((r) => r.kind === "build");
  assert.equal(builds.length, 1, "no second build row was inserted — the live build coalesces the reclaim");
  assert.equal(builds[0].id, "build-1", "the pre-existing live build row is preserved as-is");
});
