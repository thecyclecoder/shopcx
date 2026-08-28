/**
 * a-broken-verification-check-cannot-kill-a-build Phase 2 —
 * `escalateBrokenCheckWithoutRedriveCount` MUST route an unevaluable-check-failure differently
 * from `redriveDeferredBuildOrEscalate`:
 *
 *   1. NEVER writes a `redrive_deferred_build` director_activity row — that is the counter
 *      `readDeferredRedriveMax` reads for the `BUILDER_DEFERRED_REDRIVE_MAX` cap. A fault in the
 *      verification layer must not consume a slot the code-gap history relies on.
 *   2. Writes a distinct `broken_check_escalated` audit row with the full unevaluable list.
 *   3. Inserts a `needs_approval` build agent_jobs row whose instructions name every phase +
 *      offending pattern VERBATIM (the spec's escalation-shape requirement).
 *   4. Dedupes against a build already in-flight for the spec (mirrors the redrive path's guard).
 *
 * Stubs Supabase admin + director-activity via Node's module cache so the test never touches DB.
 *
 * Run:
 *   npx tsx --test src/lib/roadmap-actions.broken-check-escalate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const WORKSPACE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SPEC_SLUG = "cancelled-subs-stop-reporting-a-future-billing-date";
const SOURCE_JOB_ID = "src-job-1";

interface AgentJobRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  kind: string;
  status: string;
  instructions?: string | null;
  pending_actions?: unknown;
  created_at: string;
}

interface DirectorActivityRow {
  workspaceId: string;
  actionKind: string;
  specSlug?: string | null;
  reason: string;
  metadata?: Record<string, unknown>;
}

interface World {
  agentJobs: AgentJobRow[];
  directorActivity: DirectorActivityRow[];
  nextJobId: number;
  jobInsertError: string | null;
}

const world: World = {
  agentJobs: [],
  directorActivity: [],
  nextJobId: 1,
  jobInsertError: null,
};

function resetWorld() {
  world.agentJobs = [];
  world.directorActivity = [];
  world.nextJobId = 1;
  world.jobInsertError = null;
}

// Minimal Supabase-shaped chainable. Every terminal returns a Promise so `await admin.from().limit()`
// / `await admin.from().insert()` both work — no thenable-recursion. Only implements the operators
// the tested code actually uses.
function makeFrom(table: string) {
  const filters: Record<string, unknown> = {};
  const inFilters: Record<string, unknown[]> = {};
  let limitN: number | null = null;

  function resolveRows(): AgentJobRow[] {
    if (table !== "agent_jobs") return [];
    let rows = world.agentJobs.slice();
    const asRec = (r: AgentJobRow): Record<string, unknown> => r as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(filters)) rows = rows.filter((r) => asRec(r)[k] === v);
    for (const [k, vs] of Object.entries(inFilters)) rows = rows.filter((r) => vs.includes(asRec(r)[k]));
    if (limitN !== null) rows = rows.slice(0, limitN);
    return rows;
  }

  const chain = {
    select(_cols?: string) { return chain; },
    eq(col: string, val: unknown) { filters[col] = val; return chain; },
    in(col: string, vals: unknown[]) { inFilters[col] = vals; return chain; },
    gte(_col: string, _val: unknown) { return chain; },
    order(_col: string, _opts?: unknown) { return chain; },
    // Terminal read used by the dedupe: `await …limit(1)` resolves to `{data, error}`.
    async limit(n: number): Promise<{ data: unknown[]; error: null }> {
      limitN = n;
      return { data: resolveRows(), error: null };
    },
    // Terminal write: `await admin.from(t).insert(row)` resolves to `{error}`.
    async insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }> {
      if (world.jobInsertError) return { error: { message: world.jobInsertError } };
      if (table === "agent_jobs") {
        world.agentJobs.push({
          id: `job-${world.nextJobId++}`,
          workspace_id: String(row.workspace_id),
          spec_slug: String(row.spec_slug),
          kind: String(row.kind),
          status: String(row.status),
          instructions: (row.instructions as string | null) ?? null,
          pending_actions: row.pending_actions,
          created_at: new Date(2026, 7, 25, 10, world.nextJobId).toISOString(),
        });
      }
      return { error: null };
    },
  };
  return chain;
}

const stubAdmin = {
  from(table: string) {
    return makeFrom(table);
  },
};

const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};
moduleAny._cache[require.resolve("@/lib/director-activity")] = {
  exports: {
    recordDirectorActivity: async (
      _admin: unknown,
      input: {
        workspaceId: string;
        actionKind: string;
        specSlug?: string | null;
        reason: string;
        metadata?: Record<string, unknown>;
      },
    ) => {
      world.directorActivity.push({
        workspaceId: input.workspaceId,
        actionKind: input.actionKind,
        specSlug: input.specSlug ?? null,
        reason: input.reason,
        metadata: input.metadata,
      });
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { escalateBrokenCheckWithoutRedriveCount } =
  require("@/lib/roadmap-actions") as typeof import("./roadmap-actions");

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────

test("live-incident replay: an unevaluable check ((?i)-PCRE class) escalates without touching the redrive counter", async () => {
  resetWorld();
  const outcome = await escalateBrokenCheckWithoutRedriveCount(
    WORKSPACE_ID,
    SPEC_SLUG,
    [
      {
        phasePosition: 2,
        kind: "grep-error",
        checkDescription: "cancelled_at migration exists",
        pattern: "(?i)add column if not exists\\s+cancelled_at",
        reason: "phase 2 check — GIT ERROR on origin/claude/build-cancelled-subs-stop-reporting-a-future-billing-date: fatal: -e option, '(?i)add column if not exists\\s+cancelled_at': Invalid preceding regular expression",
      },
    ],
    SOURCE_JOB_ID,
  );
  assert.equal(outcome.action, "escalate", `expected escalate, got ${JSON.stringify(outcome)}`);

  // Invariant 1 — a NEW needs_approval build job was inserted.
  const inserted = world.agentJobs.filter((r) => r.kind === "build");
  assert.equal(inserted.length, 1, "exactly one broken-check escalation row was inserted");
  assert.equal(inserted[0].status, "needs_approval");
  assert.equal(inserted[0].spec_slug, SPEC_SLUG);

  // Invariant 2 — the escalation names the phase + pattern verbatim (per spec's message-shape).
  assert.match(inserted[0].instructions ?? "", /phase 2/i);
  assert.match(inserted[0].instructions ?? "", /GIT ERROR/);
  assert.match(inserted[0].instructions ?? "", /\(\?i\)add column if not exists\\s\+cancelled_at/);

  // Invariant 3 — pending_actions carries a broken_check payload with the full check structure.
  const actions = inserted[0].pending_actions as Array<{ type: string; checks: unknown[] }>;
  assert.equal(actions[0].type, "broken_check");
  assert.equal(actions[0].checks.length, 1);

  // Invariant 4 — CRITICAL: NO `redrive_deferred_build` director_activity row was written; only
  // `broken_check_escalated`. That is what preserves the redrive-cap counter for genuine code gaps.
  const redriveRows = world.directorActivity.filter((r) => r.actionKind === "redrive_deferred_build");
  assert.equal(redriveRows.length, 0, "MUST NOT write redrive_deferred_build — a broken check does not consume the cap");
  const brokenRows = world.directorActivity.filter((r) => r.actionKind === "broken_check_escalated");
  assert.equal(brokenRows.length, 1);
  assert.equal(brokenRows[0].metadata?.counted_against_redrive_cap, false);
});

test("multiple unevaluable checks — the summary lists every phase + pattern verbatim", async () => {
  resetWorld();
  await escalateBrokenCheckWithoutRedriveCount(
    WORKSPACE_ID,
    SPEC_SLUG,
    [
      {
        phasePosition: 1,
        kind: "grep-error",
        checkDescription: "checkA",
        pattern: "(?i)patternA",
        reason: "…",
      },
      {
        phasePosition: 3,
        kind: "unresolvable",
        checkDescription: "checkB",
        pattern: "patternB",
        reason: "…",
      },
    ],
    SOURCE_JOB_ID,
  );
  const inserted = world.agentJobs.find((r) => r.kind === "build");
  assert.ok(inserted);
  const brokenRow = world.directorActivity.find((r) => r.actionKind === "broken_check_escalated");
  assert.ok(brokenRow);
  const brokenChecks = brokenRow!.metadata?.broken_checks as Array<{ phase_position: number; kind: string; pattern: string }>;
  assert.equal(brokenChecks.length, 2);
  assert.equal(brokenChecks[0].kind, "grep-error");
  assert.equal(brokenChecks[1].kind, "unresolvable");
  // The reason string names both phases + both patterns — the human-readable escalation.
  assert.match(brokenRow!.reason, /phase 1/);
  assert.match(brokenRow!.reason, /phase 3/);
  assert.match(brokenRow!.reason, /patternA/);
  assert.match(brokenRow!.reason, /patternB/);
});

test("dedupe — a build already in-flight for the spec skips the escalation (matches redriveDeferredBuildOrEscalate's guard)", async () => {
  resetWorld();
  world.agentJobs.push({
    id: "live-build",
    workspace_id: WORKSPACE_ID,
    spec_slug: SPEC_SLUG,
    kind: "build",
    status: "building",
    created_at: "2026-08-25T10:00:00Z",
  });
  const outcome = await escalateBrokenCheckWithoutRedriveCount(
    WORKSPACE_ID,
    SPEC_SLUG,
    [{ phasePosition: 1, kind: "grep-error", checkDescription: "x", pattern: "(?i)y", reason: "…" }],
    SOURCE_JOB_ID,
  );
  assert.equal(outcome.action, "skip");
  assert.match(outcome.reason, /already in-flight/);
  // No new build job inserted and no director-activity row written.
  const builds = world.agentJobs.filter((r) => r.kind === "build");
  assert.equal(builds.length, 1, "no additional build row was inserted");
  assert.equal(world.directorActivity.length, 0, "no audit row on the skip path");
});

test("empty unevaluable list — no-op, no insert, no audit", async () => {
  resetWorld();
  const outcome = await escalateBrokenCheckWithoutRedriveCount(
    WORKSPACE_ID,
    SPEC_SLUG,
    [],
    SOURCE_JOB_ID,
  );
  assert.equal(outcome.action, "skip");
  assert.match(outcome.reason, /no unevaluable/);
  assert.equal(world.agentJobs.length, 0);
  assert.equal(world.directorActivity.length, 0);
});
