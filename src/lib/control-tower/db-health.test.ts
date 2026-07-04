/**
 * Unit tests for the PURE analyzeInstanceHealth classifier
 * (db-health-instance-saturation-detector spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/db-health.test.ts
 *
 * Focus: replay the 2026-07-02 incident numbers (rollback ratio 0.0743, temp_bytes 883 GB, cache-hit
 * 0.9869 under load, `authenticated` statement_timeout=8s) and verify the classifier fires findings
 * whose cause ∈ {statement_timeout_pressure, temp_spill_pressure, rollback_error_rate} with the
 * offending numbers present in the evidence string — the miss the per-query slow-query pass could
 * never catch. A healthy fixture (rollback <1%, no temp spill, cache-hit >0.999) must return [].
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeInstanceHealth,
  analyzeSlowQuery,
  buildFixSpecMarkdown,
  classifyExplainPlan,
  enqueueDbHealthProposal,
  getDbHealthPanel,
  isForeignQuery,
  isMaintenanceCommand,
  type InstanceHealthInput,
  type DbHealthFinding,
  type SlowQueryRow,
} from "./db-health";
import type { createAdminClient } from "@/lib/supabase/admin";

const GB = 1024 * 1024 * 1024;

/** The 2026-07-02 incident snapshot (the numbers cited in the spec). */
function incidentInput(): InstanceHealthInput {
  // rollback ratio 0.0743 → for total 1,000,000 tx we need ~74,300 rollbacks / ~925,700 commits.
  const xactCommit = 925_700;
  const xactRollback = 74_300;
  // cache-hit 0.9869 → for total 100,000,000 blks we need 98,690,000 hits / 1,310,000 reads.
  const blksHit = 98_690_000;
  const blksRead = 1_310_000;
  return {
    xactCommit,
    xactRollback,
    deadlocks: 12,
    tempFiles: 92_832,
    tempBytes: 883 * GB,
    blksHit,
    blksRead,
    activeBackends: 40,
    waitingBackends: 5,
    maxConnections: 100,
    statementsNearTimeout: 3,
    authenticatedStatementTimeoutMs: 8_000,
  };
}

/** A healthy instance — none of the flags trip. */
function healthyInput(): InstanceHealthInput {
  return {
    xactCommit: 990_000,
    xactRollback: 5_000, // 0.5% — under the 5% flag
    deadlocks: 0,
    tempFiles: 10,
    tempBytes: 1 * GB, // well under the 100 GB flag
    blksHit: 999_500,
    blksRead: 500, // cache-hit 0.9995 — above the 0.99 floor
    activeBackends: 5,
    waitingBackends: 0,
    maxConnections: 100,
    statementsNearTimeout: 0,
    authenticatedStatementTimeoutMs: 8_000,
  };
}

test("2026-07-02 incident fixture produces ≥1 finding whose cause ∈ {statement_timeout_pressure, temp_spill_pressure, rollback_error_rate}", () => {
  const findings = analyzeInstanceHealth(incidentInput());
  const incidentCauses = new Set(["statement_timeout_pressure", "temp_spill_pressure", "rollback_error_rate"]);
  const matches = findings.filter((f: DbHealthFinding) => incidentCauses.has(f.cause));
  assert.ok(
    matches.length >= 1,
    `expected ≥1 finding whose cause is one of ${[...incidentCauses].join(", ")}; got ${findings.map((f) => f.cause).join(", ") || "(none)"}`,
  );
});

test("incident evidence quotes the real numbers (rollback ratio, temp bytes, statement_timeout)", () => {
  const findings = analyzeInstanceHealth(incidentInput());

  const rollback = findings.find((f) => f.cause === "rollback_error_rate");
  assert.ok(rollback, "expected a rollback_error_rate finding");
  // rollback ratio 7.43% rounds to 7%
  assert.match(rollback!.evidence, /rollback ratio 7%/);
  assert.match(rollback!.evidence, /xact_rollback=74,300/);
  assert.match(rollback!.evidence, /xact_commit=925,700/);

  const tempSpill = findings.find((f) => f.cause === "temp_spill_pressure");
  assert.ok(tempSpill, "expected a temp_spill_pressure finding");
  assert.match(tempSpill!.evidence, /temp_files: 92,832/);
  assert.match(tempSpill!.evidence, /883 GB/);

  const timeout = findings.find((f) => f.cause === "statement_timeout_pressure");
  assert.ok(timeout, "expected a statement_timeout_pressure finding when statementsNearTimeout > 0");
  assert.match(timeout!.evidence, /statement_timeout` = 8000 ms/);
  assert.match(timeout!.evidence, /Live queries past 50% of the ceiling: 3/);
});

test("every incident finding is category='instance' and carries a stable dbhealth:instance:<cause> signature", () => {
  const findings = analyzeInstanceHealth(incidentInput());
  assert.ok(findings.length > 0, "expected findings on the incident fixture");
  for (const f of findings) {
    assert.equal(f.category, "instance", `${f.cause} should be category='instance'`);
    assert.match(f.signature, /^dbhealth:instance:/);
    assert.equal(f.signature, `dbhealth:instance:${f.cause}`);
  }
});

test("healthy fixture (rollback <1%, no temp spill, cache-hit >0.999) returns []", () => {
  const findings = analyzeInstanceHealth(healthyInput());
  assert.deepEqual(findings, []);
});

test("threshold overrides let the caller tune each flag independently", () => {
  // Take the incident numbers but raise every threshold above them — everything clears except
  // statement_timeout_pressure, which is driven by a live-query count (not a threshold).
  const findings = analyzeInstanceHealth(incidentInput(), {
    rollbackRatioFlag: 0.9,
    tempBytesWindowFlag: 10_000 * GB,
    cacheHitFloor: 0.5,
    connUtilFlag: 0.99,
  });
  const causes = findings.map((f) => f.cause);
  assert.deepEqual(causes, ["statement_timeout_pressure"]);
});

test("statement_timeout_pressure does NOT fire when the `authenticated` timeout is unset", () => {
  const input = incidentInput();
  input.authenticatedStatementTimeoutMs = null;
  input.statementsNearTimeout = 5; // even with waiters, no ceiling → no finding
  const findings = analyzeInstanceHealth(input);
  assert.equal(findings.find((f) => f.cause === "statement_timeout_pressure"), undefined);
});

// db-investigate-timeouts-instance — the offender samples show up in the finding evidence when
// the box captured them, so the operator can route the specific query to the right slow-query fix
// without a separate pg_stat_activity probe. Un-actionable "1 live query near timeout" was the gap.
test("statement_timeout_pressure evidence names the OFFENDER when nearTimeoutSamples are provided", () => {
  const input = incidentInput();
  input.statementsNearTimeout = 2;
  input.nearTimeoutSamples = [
    { durationSec: 7, query: "select tag from tickets where tags @> $1" },
    { durationSec: 5, query: "select count(*) from   sms_campaign_recipients   where message_sid = $1" },
  ];
  const findings = analyzeInstanceHealth(input);
  const timeout = findings.find((f) => f.cause === "statement_timeout_pressure");
  assert.ok(timeout, "expected a statement_timeout_pressure finding");
  assert.match(timeout!.evidence, /Near-timeout offenders/);
  assert.match(timeout!.evidence, /7s — `select tag from tickets where tags @> \$1`/);
  // Whitespace in the second query is collapsed by the preview.
  assert.match(timeout!.evidence, /5s — `select count\(\*\) from sms_campaign_recipients where message_sid = \$1`/);
});

test("statement_timeout_pressure evidence works WITHOUT nearTimeoutSamples (back-compat)", () => {
  const input = incidentInput();
  input.statementsNearTimeout = 1;
  delete input.nearTimeoutSamples;
  const findings = analyzeInstanceHealth(input);
  const timeout = findings.find((f) => f.cause === "statement_timeout_pressure");
  assert.ok(timeout, "expected a statement_timeout_pressure finding");
  // No offender lines when the box didn't capture samples — the count still fires the signal.
  assert.doesNotMatch(timeout!.evidence, /Near-timeout offender/);
  assert.match(timeout!.evidence, /Live queries past 50% of the ceiling: 1/);
});

test("statement_timeout_pressure caps the offender-sample lines at 3 (evidence stays readable)", () => {
  const input = incidentInput();
  input.statementsNearTimeout = 10;
  input.nearTimeoutSamples = Array.from({ length: 6 }, (_, i) => ({ durationSec: 4 + i, query: `select q_${i}` }));
  const findings = analyzeInstanceHealth(input);
  const timeout = findings.find((f) => f.cause === "statement_timeout_pressure");
  assert.ok(timeout);
  const matches = timeout!.evidence.match(/^ {2}- \d+s — /gm) ?? [];
  assert.equal(matches.length, 3, `expected ≤3 sample lines; got ${matches.length}`);
});

test("statement_timeout_pressure long offender queries are truncated in the preview", () => {
  const long = "select ".repeat(80); // > 500 chars
  const input = incidentInput();
  input.statementsNearTimeout = 1;
  input.nearTimeoutSamples = [{ durationSec: 6, query: long }];
  const findings = analyzeInstanceHealth(input);
  const timeout = findings.find((f) => f.cause === "statement_timeout_pressure");
  assert.ok(timeout);
  assert.match(timeout!.evidence, /…`/);
});

test("connection_saturation fires when active+waiting cross the flag", () => {
  const input = healthyInput();
  input.activeBackends = 70;
  input.waitingBackends = 15; // 85% of 100 max_connections → over the 80% flag
  const findings = analyzeInstanceHealth(input);
  const conn = findings.find((f) => f.cause === "connection_saturation");
  assert.ok(conn, "expected connection_saturation over the 80% flag");
  assert.match(conn!.evidence, /85% utilization/);
});

// ── Phase 2 verification (advisory templating + surface + dedup + panel) ─────

test("buildFixSpecMarkdown on an instance finding is non-empty, has ≥1 `## Phase`, and carries the DBHealth-signature + DBHealth-fix + owner-approval-only markers", () => {
  const findings = analyzeInstanceHealth(incidentInput());
  const f = findings.find((x) => x.cause === "temp_spill_pressure");
  assert.ok(f, "expected a temp_spill_pressure finding on the incident fixture");

  const body = buildFixSpecMarkdown(f!);
  assert.ok(body.trim().length > 0, "spec body must be non-empty");
  const phaseHeaders = body.match(/^## Phase\b/gm) ?? [];
  assert.ok(phaseHeaders.length >= 1, `expected ≥1 '## Phase' header; got ${phaseHeaders.length}`);
  assert.match(body, /\*\*DBHealth-signature:\*\* `dbhealth:instance:temp_spill_pressure`/);
  assert.match(body, /\*\*DBHealth-fix:\*\* `raise_work_mem`/);
  // "Owner-approval-only" language is the north-star advisory stance the spec requires.
  assert.match(body, /owner-approval-only/i);
  assert.match(body, /no auto-apply/i);
  // The evidence numbers are quoted verbatim.
  assert.match(body, /883 GB/);
});

test("buildFixSpecMarkdown resolves cause-specific guidance for statement_timeout_pressure (not the generic investigate_timeouts fallback)", () => {
  const findings = analyzeInstanceHealth(incidentInput());
  const f = findings.find((x) => x.cause === "statement_timeout_pressure");
  assert.ok(f, "expected a statement_timeout_pressure finding");
  const body = buildFixSpecMarkdown(f!);
  // Cause-specific guidance includes the timeout headroom fraction phrasing (Phase 2 branch), not
  // ONLY the coarser fix-kind fallback.
  assert.match(body, /Live queries are running past 50% of the `authenticated` `statement_timeout`/i);
  assert.match(body, /Impact quoted verbatim from the evidence/);
});

// ── Fake admin — a chainable in-memory Supabase double for the surface + panel tests ───

interface FakeAgentJob {
  id: string;
  workspace_id: string;
  spec_slug: string;
  kind: string;
  status: string;
  log_tail: string | null;
  instructions: string | null;
  pending_actions: unknown;
  created_at: string;
  error: string | null;
}
interface FakeWorkspace { id: string; created_at: string }
interface FakeHeartbeat { loop_id: string; ran_at: string; produced: unknown }
interface FakeTableSizeRow { captured_at: string; table_name: string; total_bytes: number; row_estimate: number }

function fakeAdmin(seed: {
  agent_jobs?: FakeAgentJob[];
  workspaces?: FakeWorkspace[];
  loop_heartbeats?: FakeHeartbeat[];
  db_table_size_history?: FakeTableSizeRow[];
}): ReturnType<typeof createAdminClient> {
  const state = {
    agent_jobs: [...(seed.agent_jobs ?? [])],
    workspaces: [...(seed.workspaces ?? [])],
    loop_heartbeats: [...(seed.loop_heartbeats ?? [])],
    db_table_size_history: [...(seed.db_table_size_history ?? [])],
  };
  let nextId = 1;

  const build = (table: keyof typeof state) => {
    let rows: unknown[] = state[table] as unknown[];
    let filtered = [...rows];
    let ordered = false;
    let ascending = false;
    let orderCol: string = "created_at";
    let limitN = Infinity;

    const eq = (col: string, val: unknown) => {
      filtered = filtered.filter((r) => (r as Record<string, unknown>)[col] === val);
      return chain;
    };
    const inFilter = (col: string, vals: unknown[]) => {
      const set = new Set(vals);
      filtered = filtered.filter((r) => set.has((r as Record<string, unknown>)[col]));
      return chain;
    };
    const lt = (col: string, val: unknown) => {
      filtered = filtered.filter((r) => ((r as Record<string, unknown>)[col] as string) < (val as string));
      return chain;
    };

    const chain = {
      select: (_cols?: string) => chain,
      eq,
      in: inFilter,
      lt,
      order: (col: string, opts: { ascending?: boolean } = {}) => {
        ordered = true;
        orderCol = col;
        ascending = !!opts.ascending;
        return chain;
      },
      limit: (n: number) => { limitN = n; return chain; },
      maybeSingle: async () => {
        applyOrderLimit();
        return { data: (filtered[0] as unknown) ?? null, error: null };
      },
      insert: async (row: unknown) => {
        const rec = row as Record<string, unknown>;
        const withDefaults = { id: `job-${nextId++}`, created_at: new Date(2026, 6, 2).toISOString(), error: null, ...rec };
        (state[table] as unknown[]).push(withDefaults);
        return { data: null, error: null };
      },
      then: async (onFulfilled: (v: { data: unknown[]; error: null }) => unknown) => {
        applyOrderLimit();
        return onFulfilled({ data: filtered, error: null });
      },
    } as unknown as Record<string, unknown>;

    function applyOrderLimit() {
      if (ordered) {
        filtered = [...filtered].sort((a, b) => {
          const av = (a as Record<string, unknown>)[orderCol] as string;
          const bv = (b as Record<string, unknown>)[orderCol] as string;
          return ascending ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
        });
      }
      if (Number.isFinite(limitN)) filtered = filtered.slice(0, limitN);
    }
    return chain;
  };

  return { from: (t: string) => build(t as keyof typeof state) } as unknown as ReturnType<typeof createAdminClient>;
}

const WORKSPACE_ID = "ws-1";

function seedAdmin() {
  return fakeAdmin({
    agent_jobs: [], // needed so resolveDbHealthWorkspace can fall back to workspaces
    workspaces: [{ id: WORKSPACE_ID, created_at: "2026-01-01T00:00:00Z" }],
  });
}

// ── agent-mandate-hardening-dbhealth guardrails (rolled coaching baked into the classifier) ──
//
// Devi sat at 4.8/10 after 10 coaching passes because the slow-query path fell through to
// bloat_stale_stats/vacuum_tuning whenever the plan didn't isolate a Seq Scan — misdiagnosing
// erratic-stddev / index-driven / high-call-volume queries as bloat. The rolled fix (baked into
// classifyExplainPlan + analyzeSlowQuery) makes vacuum_tuning UNREACHABLE from the slow-query path.
// Tests below are regression locks against the exact dismissed findings in the coaching.

/** Boilerplate row builder — over the slow-per-call floor so highCallVolume DOESN'T short-circuit
 *  the case we care about (the classifier fallback). */
function slowRow(overrides: Partial<SlowQueryRow>): SlowQueryRow {
  return {
    queryid: "test-1",
    query: "select * from t where c = $1",
    calls: 1000,
    total_exec_time: 400_000,
    mean_exec_time: 400, // ≥ SLOW_PER_CALL_MEAN_MS so the pure-volume branch is skipped
    stddev_exec_time: 50, // low stddev by default (not erratic)
    rows: 100,
    ...overrides,
  };
}

test("classifyExplainPlan — index-driven plan (Bitmap Index Scan, no Seq Scan) diagnoses no_index_match, NEVER bloat_stale_stats", () => {
  // The tickets q6690 dismissal: `tags @> $3` used a Bitmap Index Scan on idx_tickets_tags_gin —
  // the owner killed the vacuum proposal saying "vacuum won't help".
  const plan = [
    "Aggregate  (cost=1.00..1.01 rows=1 width=8)",
    "  ->  Bitmap Heap Scan on tickets  (cost=1.00..1.00 rows=1 width=0)",
    "        Recheck Cond: (tags @> '{urgent}'::text[])",
    "        ->  Bitmap Index Scan on idx_tickets_tags_gin  (cost=0.00..1.00 rows=1 width=0)",
    "              Index Cond: (tags @> '{urgent}'::text[])",
  ].join("\n");
  const cls = classifyExplainPlan(plan);
  assert.equal(cls.cause, "no_index_match");
  assert.notEqual(cls.cause, "bloat_stale_stats");
  assert.match(cls.hint, /index-driven/i);
  assert.match(cls.hint, /vacuum cannot help/i);
});

test("classifyExplainPlan — Index Scan plan (message_sid = $1 class) diagnoses no_index_match, NEVER bloat_stale_stats", () => {
  // The sms_campaign_recipients q7780 dismissal: `message_sid = $1` used an Index Scan on
  // sms_campaign_recipients_message_sid_idx — the owner killed the vacuum proposal saying
  // "smells like a missing index, not vacuum/bloat".
  const plan = [
    "Limit  (cost=0.42..8.44 rows=1 width=100)",
    "  ->  Index Scan using sms_campaign_recipients_message_sid_idx on sms_campaign_recipients",
    "        Index Cond: (message_sid = $1)",
  ].join("\n");
  const cls = classifyExplainPlan(plan);
  assert.equal(cls.cause, "no_index_match");
  assert.notEqual(cls.cause, "bloat_stale_stats");
});

test("classifyExplainPlan — no scan node at all (pure Aggregate/Limit) diagnoses high_call_volume, NEVER bloat_stale_stats", () => {
  // The parameterized Aggregate → Limit shape from the sms dismissal, stripped of index nodes.
  const plan = "Aggregate  (cost=1.00..1.01 rows=1 width=8)\n  ->  Limit  (cost=0.00..1.00 rows=1 width=8)";
  const cls = classifyExplainPlan(plan);
  assert.equal(cls.cause, "high_call_volume");
  assert.notEqual(cls.cause, "bloat_stale_stats");
});

test("classifyExplainPlan — bare Seq Scan still diagnoses seq_scan (regression lock: guardrail didn't over-rotate)", () => {
  // The orders-class win — a real Seq Scan MUST still route to seq_scan/add_index. The guardrail
  // must not accidentally suppress this path.
  const plan = "Seq Scan on orders  (cost=0.00..10000 rows=100000 width=100)\n  Filter: (workspace_id = 'x')\n  Rows Removed by Filter: 125137";
  const cls = classifyExplainPlan(plan);
  assert.equal(cls.cause, "seq_scan");
  assert.deepEqual(cls.seqScanTables, ["orders"]);
});

test("analyzeSlowQuery — mean=200ms + high stddev + index-driven plan → add_index (NOT vacuum_tuning)", () => {
  // Erratic per-call plan above SLOW_PER_CALL_MEAN_MS (so the volume shortcut doesn't hit) with
  // an Index Scan (rules out seq_scan) and stddev > mean. Must produce add_index / no_index_match.
  const plan = "Index Scan using idx_things on things\n  Index Cond: (c = $1)";
  const row = slowRow({ mean_exec_time: 200, stddev_exec_time: 800, calls: 5_000 });
  const finding = analyzeSlowQuery(row, plan);
  assert.ok(finding, "expected a finding on an over-floor slow query");
  assert.equal(finding!.cause, "no_index_match");
  assert.equal(finding!.fixKind, "add_index");
  assert.notEqual(finding!.fixKind, "vacuum_tuning");
});

test("analyzeSlowQuery — tickets `tags @> $3` at 4ms×1.27M diagnosed high_call_volume + GIN hint (never vacuum)", () => {
  // The exact dismissed shape from the coaching. mean < SLOW_PER_CALL_MEAN_MS routes to the
  // volume branch; the `@>` predicate triggers the GIN hint. Vacuum must not be the fix.
  const row = slowRow({
    queryid: "6690475994378406674",
    query: "select id from tickets where tags @> $3",
    calls: 1_270_000,
    total_exec_time: 5_080_000,
    mean_exec_time: 4,
    stddev_exec_time: 5,
  });
  const finding = analyzeSlowQuery(row, null);
  assert.ok(finding);
  assert.equal(finding!.cause, "high_call_volume");
  assert.equal(finding!.fixKind, "reduce_calls");
  assert.notEqual(finding!.fixKind, "vacuum_tuning");
  assert.match(finding!.evidence, /GIN/);
});

test("analyzeSlowQuery — sms `message_sid = $1` at 31ms×157k diagnosed high_call_volume (never vacuum)", () => {
  // The other dismissed shape. mean < 50ms routes to volume; message_sid is an equality predicate
  // (no `@>`), so no GIN hint required. Vacuum must not be the fix.
  const row = slowRow({
    queryid: "7780b208848b",
    query: "select id from sms_campaign_recipients where message_sid = $1",
    calls: 157_000,
    total_exec_time: 4_867_000,
    mean_exec_time: 31,
    stddev_exec_time: 66,
  });
  const finding = analyzeSlowQuery(row, null);
  assert.ok(finding);
  assert.equal(finding!.cause, "high_call_volume");
  assert.equal(finding!.fixKind, "reduce_calls");
  assert.notEqual(finding!.fixKind, "vacuum_tuning");
});

test("isMaintenanceCommand — VACUUM/ANALYZE/CLUSTER/REINDEX are maintenance, a SELECT is not", () => {
  assert.equal(isMaintenanceCommand("VACUUM (ANALYZE) public.orders"), true);
  assert.equal(isMaintenanceCommand("  vacuum analyze orders"), true);
  assert.equal(isMaintenanceCommand("ANALYZE public.customers"), true);
  assert.equal(isMaintenanceCommand("REINDEX INDEX idx_foo"), true);
  assert.equal(isMaintenanceCommand("CLUSTER orders USING idx_orders_pk"), true);
  // A read query that merely MENTIONS the word (column/alias) must NOT be flagged.
  assert.equal(isMaintenanceCommand("select id, analyze_result from reports where c = $1"), false);
  assert.equal(isMaintenanceCommand("select * from orders where c = $1"), false);
});

test("analyzeSlowQuery — VACUUM maintenance command → NO proposal (2026-07-04 reduce_calls noise class)", () => {
  // queryids -7677994386067890637 / 2919954756727600022: a one-off VACUUM (ANALYZE) public.orders that
  // pg_stat_statements surfaced at ~5s. It isn't a SELECT (no EXPLAIN), was misclassified as
  // high_call_volume, and produced a nonsense reduce_calls proposal. The maintenance guard drops it.
  const row = slowRow({
    queryid: "-7677994386067890637",
    query: "VACUUM (ANALYZE) public.orders",
    calls: 1,
    total_exec_time: 4_602,
    mean_exec_time: 4_602,
    stddev_exec_time: 0,
  });
  assert.equal(analyzeSlowQuery(row, null), null);
});

test("isForeignQuery / analyzeSlowQuery — unqualified pg_catalog introspection is foreign → NO proposal (q4272 class)", () => {
  // PostgREST's schema-introspection query references pg_constraint/pg_class/pg_attribute/pg_namespace
  // WITHOUT a pg_catalog. prefix, so the old `\bpg_catalog\b`-only filter missed it and it produced a
  // bogus add_index proposal on `(query)` (queryid 4272184973515172242).
  const introspection =
    "select c.conname, c.conrelid from pg_constraint c join pg_class r on r.oid = c.conrelid " +
    "join pg_namespace n on n.oid = r.relnamespace join pg_attribute a on a.attrelid = r.oid";
  assert.equal(isForeignQuery(introspection), true);
  const row = slowRow({ queryid: "4272184973515172242", query: introspection });
  assert.equal(analyzeSlowQuery(row, null), null);
  // A normal public.* app query is NOT foreign.
  assert.equal(isForeignQuery("select id from orders where customer_id = $1"), false);
});

test("analyzeSlowQuery — no plan available + bounded query → high_call_volume fallback (NEVER vacuum_tuning)", () => {
  // Pre-guardrail this fell through to the `cause = "seq_scan"` no-plan branch — now the final
  // fallback (bounded query, no aggregate, no plan) must be high_call_volume/reduce_calls with the
  // "vacuum belongs to the size-sweep bloat path" language, so the operator never sees a
  // groundless vacuum proposal. Use a LIMITed query so missing_limit/full_aggregate don't fire.
  const row = slowRow({
    query: "select id from things where c = $1 limit 100",
    mean_exec_time: 500,
    stddev_exec_time: 100,
  });
  const finding = analyzeSlowQuery(row, null);
  assert.ok(finding);
  assert.notEqual(finding!.fixKind, "vacuum_tuning");
  assert.equal(finding!.cause, "high_call_volume");
  assert.match(finding!.evidence, /vacuum/i); // the hint explains why we didn't propose one
});

test("analyzeSlowQuery — INVARIANT: no shape of slow-query row/plan ever produces fixKind=vacuum_tuning", () => {
  // A pathological grid of shapes the coaching says used to mislabel as vacuum. Every one must
  // resolve to something other than vacuum_tuning — the slow-query path never proposes a vacuum.
  const shapes: Array<{ row: SlowQueryRow; plan: string | null; label: string }> = [
    { row: slowRow({ query: "select 1 from t where c = $1", mean_exec_time: 300, stddev_exec_time: 1200 }), plan: "Index Scan using x on t\n  Index Cond: (c = $1)", label: "erratic index scan" },
    { row: slowRow({ query: "select 1 from t where c @> $1", mean_exec_time: 4, stddev_exec_time: 5, calls: 1_000_000 }), plan: null, label: "high-volume @>" },
    { row: slowRow({ query: "select 1 from t where c = $1", mean_exec_time: 31, stddev_exec_time: 66, calls: 157_000 }), plan: null, label: "high-volume equality" },
    { row: slowRow({ query: "select 1 from t where c = $1", mean_exec_time: 500, stddev_exec_time: 50 }), plan: "Aggregate\n  ->  Limit", label: "no-scan aggregate/limit" },
    { row: slowRow({ query: "select 1 from t where c = $1", mean_exec_time: 500, stddev_exec_time: 50 }), plan: "Bitmap Heap Scan on t\n  ->  Bitmap Index Scan on ix", label: "bitmap-index driven" },
    { row: slowRow({ query: "select 1 from t where c = $1", mean_exec_time: 500, stddev_exec_time: 50 }), plan: null, label: "no plan" },
  ];
  for (const { row, plan, label } of shapes) {
    const finding = analyzeSlowQuery(row, plan);
    assert.ok(finding, `${label}: expected a finding`);
    assert.notEqual(finding!.fixKind, "vacuum_tuning", `${label}: slow-query path must never propose vacuum_tuning (got cause=${finding!.cause})`);
  }
});

test("Phase 2 dedup — two identical instance findings enqueue ONE proposal (second returns {enqueued:false})", async () => {
  const findings = analyzeInstanceHealth(incidentInput());
  const rollback = findings.find((f) => f.cause === "rollback_error_rate");
  assert.ok(rollback, "expected a rollback_error_rate finding");

  const admin = seedAdmin();
  const first = await enqueueDbHealthProposal(admin, rollback!);
  assert.equal(first.enqueued, true, `first enqueue must succeed, got ${JSON.stringify(first)}`);

  const second = await enqueueDbHealthProposal(admin, rollback!);
  assert.equal(second.enqueued, false, "second enqueue must be deduped");
  assert.match(second.reason ?? "", /live proposal exists/);
});

test("Phase 2 panel — an enqueued instance proposal shows up in getDbHealthPanel({proposals})", async () => {
  const findings = analyzeInstanceHealth(incidentInput());
  const rollback = findings.find((f) => f.cause === "rollback_error_rate");
  assert.ok(rollback, "expected a rollback_error_rate finding");

  const admin = seedAdmin();
  const first = await enqueueDbHealthProposal(admin, rollback!);
  assert.equal(first.enqueued, true);

  const panel = await getDbHealthPanel(admin, WORKSPACE_ID);
  const match = panel.proposals.find((p) => p.signature === "dbhealth:instance:rollback_error_rate");
  assert.ok(match, `expected the enqueued instance finding to appear in panel.proposals; got ${JSON.stringify(panel.proposals)}`);
  assert.equal(match!.cause, "rollback_error_rate");
  assert.equal(match!.category, "instance");
});
