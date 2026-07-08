/**
 * Unit tests for ada-grading-sampled-adaptive-cadence Phase 1 — the sampled, cadenced, adaptive-by-
 * rollup grader in `src/lib/agents/agent-grader.ts`. Node's built-in test runner, no Supabase / LLM
 * stubs — the pure sampler + cadence gate + infra-cancel classifier are all directly exercised.
 *
 *   npm run test:agent-grader
 *   (= tsx --test src/lib/agents/agent-grader.test.ts)
 *
 * Covers the spec's three Verification bullets:
 *  1. Adaptive-by-rollup sampling — a high-average worker contributes strictly FEWER jobs to the
 *     bounded sample than a low-average one at equal pool sizes.
 *  2. Infra-cancel exclusion — a `runaway/zombie/cancelled/reaper` failure is NOT in the failure-
 *     priority set; a genuine `tsc failed`/`build failed` is.
 *  3. Cadence gate — within GRADE_CADENCE_MS of the last graded row → not-ready (a no-op).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_INFLIGHT_SKIP_REASONS,
  BLAMELESS_INFRA_RECONCILE_MARKER,
  GRADE_BATCH_CAP,
  GRADE_CADENCE_MS,
  applyBoxGrade,
  isBlamelessInfraFailure,
  isInCoachLowGradeWindow,
  isInfraCancelledError,
  matchedBlamelessInfraSignatureKey,
  reconcileBlamelessGradePoison,
  selectGradingBatch,
  withinGradeCadence,
  type UngradedJob,
} from "./agent-grader";

// ── infra-cancel classifier ─────────────────────────────────────────────────────────────────────

test("isInfraCancelledError: spec-stated keywords (runaway/zombie/cancelled) match", () => {
  assert.equal(isInfraCancelledError("runaway grading pass — killed by budget"), true);
  assert.equal(isInfraCancelledError("box zombie session — reaped"), true);
  assert.equal(isInfraCancelledError("build auto-cancelled: spec archived"), true);
});

test("isInfraCancelledError: box reaper stamps match (the actual prod strings)", () => {
  assert.equal(
    isInfraCancelledError("stale-session reaper: session died mid-run 2× (>= 3); escalating instead of re-queuing (heartbeat stale ~14m)"),
    true,
  );
  assert.equal(isInfraCancelledError("stale-session reaper: escalated"), true);
});

test("isInfraCancelledError: genuine worker failures are NOT infra-cancels", () => {
  assert.equal(isInfraCancelledError("tsc failed: 3 type errors in src/lib/foo.ts"), false);
  assert.equal(isInfraCancelledError("build failed: next build exited 1"), false);
  assert.equal(isInfraCancelledError("PR conflict — merge blocked"), false);
  assert.equal(isInfraCancelledError("Vale: needs_fix — missing owner"), false);
});

test("isInfraCancelledError: empty/null error is never an infra-cancel", () => {
  assert.equal(isInfraCancelledError(null), false);
  assert.equal(isInfraCancelledError(undefined), false);
  assert.equal(isInfraCancelledError(""), false);
});

// ── adaptive-by-rollup sampling (spec Verification #1) ──────────────────────────────────────────

/** Build N synthetic successful jobs for a kind, with monotonically-decreasing `created_at`
 *  (index 0 = newest). Status is `completed` (a success) so the sample-rate path applies. */
function makeSuccessPool(kind: string, n: number, startIdx = 0): UngradedJob[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${kind}-ok-${startIdx + i}`,
    kind,
    status: "completed",
    error: null,
    created_at: new Date(2026, 0, 1, 0, 0, 0, startIdx + i).toISOString(),
  }));
}

test("selectGradingBatch: a high-avg worker contributes STRICTLY FEWER jobs than a low-avg one at equal pool sizes", () => {
  // Two workers, equal pool sizes, wildly different rolling averages. gradeSampleRateForAvg:
  //   avg=9.5 (excellent) → sample rate 0.1
  //   avg=6.0 (learning)  → sample rate 1.0
  // Expected: over many iterations, the learning worker contributes ~10× the sample count.
  const N = 30;
  const cap = 20; // > 1×N but < 2×N, so the sampler MUST throttle at least one kind
  const rollupByKind = new Map([
    ["excellent", { average: 9.5, count: 10 }],
    ["learning", { average: 6.0, count: 10 }],
  ]);
  let excellentTotal = 0;
  let learningTotal = 0;
  const iterations = 200;
  for (let i = 0; i < iterations; i++) {
    const pool = [...makeSuccessPool("excellent", N), ...makeSuccessPool("learning", N)];
    const chosen = selectGradingBatch(pool, cap, rollupByKind);
    for (const j of chosen) {
      if (j.kind === "excellent") excellentTotal++;
      else if (j.kind === "learning") learningTotal++;
    }
  }
  // The high-avg worker's share is a small fraction of the low-avg worker's share.
  assert.ok(
    excellentTotal < learningTotal,
    `excellent (avg=9.5) contributed ${excellentTotal}; learning (avg=6.0) contributed ${learningTotal} — expected excellent < learning`,
  );
  // Adaptive floor: excellent is still sampled occasionally — never 0 across 200 iterations.
  assert.ok(excellentTotal > 0, "excellent worker was NEVER sampled — the floor (0.1) must keep regression catchable");
});

test("selectGradingBatch: three tiers (excellent < proven < learning) — monotone inverse to avg", () => {
  const N = 30;
  const cap = 25;
  const rollupByKind = new Map([
    ["excellent", { average: 9.5, count: 10 }],
    ["proven", { average: 8.3, count: 10 }],
    ["learning", { average: 6.0, count: 10 }],
  ]);
  const totals: Record<string, number> = { excellent: 0, proven: 0, learning: 0 };
  const iterations = 200;
  for (let i = 0; i < iterations; i++) {
    const pool = [
      ...makeSuccessPool("excellent", N),
      ...makeSuccessPool("proven", N, N),
      ...makeSuccessPool("learning", N, 2 * N),
    ];
    for (const j of selectGradingBatch(pool, cap, rollupByKind)) totals[j.kind]++;
  }
  assert.ok(
    totals.excellent < totals.proven && totals.proven < totals.learning,
    `expected excellent < proven < learning; got ${JSON.stringify(totals)}`,
  );
});

test("selectGradingBatch: pool ≤ cap → returns the whole pool (no throttling applied)", () => {
  const pool = makeSuccessPool("excellent", GRADE_BATCH_CAP - 2);
  const rollupByKind = new Map([["excellent", { average: 9.5, count: 10 }]]);
  const chosen = selectGradingBatch(pool, GRADE_BATCH_CAP, rollupByKind);
  assert.equal(chosen.length, pool.length, "when the pool fits under the cap, no throttling should drop anything");
});

// ── infra-cancel exclusion from the failure-priority set (spec Verification #2) ─────────────────

test("selectGradingBatch: a genuine `failed` job is in the failure-priority set (always graded regardless of sample rate)", () => {
  const genuineFail: UngradedJob = {
    id: "excellent-fail-1",
    kind: "excellent",
    status: "failed",
    error: "tsc failed: 5 type errors",
    created_at: new Date(2026, 0, 2).toISOString(),
  };
  // Pack the pool with excellent successes (throttled to 0.1) so the sampler MUST throttle. A
  // genuine failure must still land in the chosen set every iteration.
  const rollupByKind = new Map([["excellent", { average: 9.5, count: 10 }]]);
  for (let i = 0; i < 50; i++) {
    const pool = [genuineFail, ...makeSuccessPool("excellent", 40)];
    const chosen = selectGradingBatch(pool, GRADE_BATCH_CAP, rollupByKind);
    assert.ok(chosen.find((j) => j.id === "excellent-fail-1"), "a genuine tsc failure must be in every batch (failure-priority set)");
  }
});

test("selectGradingBatch: an INFRA-CANCELLED `failed` job is NOT in the failure-priority set (it flows through the success sample-rate path)", () => {
  const reaperFail: UngradedJob = {
    id: "excellent-reap-1",
    kind: "excellent",
    status: "failed",
    error: "stale-session reaper: session died mid-run 3× (>= 3); escalating",
    created_at: new Date(2026, 0, 2).toISOString(),
  };
  const rollupByKind = new Map([["excellent", { average: 9.5, count: 10 }]]);
  let selectedCount = 0;
  const iterations = 200;
  for (let i = 0; i < iterations; i++) {
    const pool = [reaperFail, ...makeSuccessPool("excellent", 40)];
    const chosen = selectGradingBatch(pool, GRADE_BATCH_CAP, rollupByKind);
    if (chosen.find((j) => j.id === "excellent-reap-1")) selectedCount++;
  }
  // Under the failure-priority rule this would be 200/200 (always graded). Under the fix, it's
  // throttled by the 0.1 sample rate — so the observed selection rate is FAR below 100%. A generous
  // ceiling (75%) still catches the regression while tolerating stochastic drift.
  assert.ok(
    selectedCount < iterations * 0.75,
    `reaper-killed job was graded ${selectedCount}/${iterations} times — expected sample-rate-throttled, not always-graded`,
  );
});

// ── cadence gate (spec Verification #3) ─────────────────────────────────────────────────────────

test("withinGradeCadence: within window → true (a second pass is a no-op)", () => {
  const now = new Date("2026-07-02T12:00:00Z").getTime();
  const halfWindowAgo = new Date(now - GRADE_CADENCE_MS / 2).toISOString();
  assert.equal(withinGradeCadence(halfWindowAgo, now), true);
});

test("withinGradeCadence: past window → false (the next pass is unblocked)", () => {
  const now = new Date("2026-07-02T12:00:00Z").getTime();
  const pastWindow = new Date(now - GRADE_CADENCE_MS - 60_000).toISOString();
  assert.equal(withinGradeCadence(pastWindow, now), false);
});

test("withinGradeCadence: never-graded (null) → false (the FIRST pass is always allowed)", () => {
  assert.equal(withinGradeCadence(null), false);
});

test("withinGradeCadence: right at the edge → false (window is strict <, not ≤ — a pass at exactly cadence is allowed)", () => {
  const now = new Date("2026-07-02T12:00:00Z").getTime();
  const exactly = new Date(now - GRADE_CADENCE_MS).toISOString();
  assert.equal(withinGradeCadence(exactly, now), false);
});

test("withinGradeCadence: cadence override — a tighter cadence rejects sooner", () => {
  const now = new Date("2026-07-02T12:00:00Z").getTime();
  const oneMinAgo = new Date(now - 60_000).toISOString();
  assert.equal(withinGradeCadence(oneMinAgo, now, 30_000), false); // past 30s override
  assert.equal(withinGradeCadence(oneMinAgo, now, 120_000), true); // still within 2min override
});

test("GRADE_CADENCE_MS default is ~2h", () => {
  // Env-overridable, but the default matches the spec's ~2h floor.
  assert.equal(GRADE_CADENCE_MS, 2 * 60 * 60 * 1000);
});

test("GRADE_BATCH_CAP default is 12 (env-overridable)", () => {
  assert.equal(GRADE_BATCH_CAP, 12);
});

// ── isBlamelessInfraFailure — grader-treats-infra-outage-failures-as-blameless-not-low-grades P1 ──
//
// Concrete 2026-07-08 outage signatures the grader must SKIP (write NO low grade) and the coach
// must EXCLUDE from its low-grade window — so a burst of outage errors can't poison the rollup or
// perpetually re-park needs_attention. Conservative: a parseable-but-wrong verdict is NEVER
// blameless; a worker's real judgment slip stays coachable even if an outage co-occurred.

test("isBlamelessInfraFailure: (a) CLI-auth outage strings → blameless", () => {
  assert.equal(isBlamelessInfraFailure({ error: "authentication_failed — CLAUDE_CONFIG_DIR credentials expired" }), true);
  assert.equal(isBlamelessInfraFailure({ error: "Not logged in. Run /login to authenticate." }), true);
  assert.equal(isBlamelessInfraFailure({ error: "session error: Please run /login before invoking claude" }), true);
});

test("isBlamelessInfraFailure: (b) 0 input+output tokens with no parseable output → blameless", () => {
  assert.equal(
    isBlamelessInfraFailure({
      input_tokens: 0,
      output_tokens: 0,
      log_tail: "session ended with no output — 0-token dead session",
    }),
    true,
  );
  // Guardrail on (b): tokens 0 with a null blob is NOT blameless (could be an unmetered clean success).
  assert.equal(isBlamelessInfraFailure({ input_tokens: 0, output_tokens: 0, error: null, log_tail: null }), false);
  // Guardrail on (b): tokens > 0 AND "no output" is NOT the 0-token signature; must be tokens==0.
  assert.equal(
    isBlamelessInfraFailure({ input_tokens: 100, output_tokens: 50, log_tail: "no output" }),
    false,
  );
});

test("isBlamelessInfraFailure: (c) 'all Max accounts capped' Max-cap park → blameless", () => {
  assert.equal(
    isBlamelessInfraFailure({ error: "usage limit reached — all Max accounts capped (parked; auto-resumes at the soonest reset)" }),
    true,
  );
  assert.equal(isBlamelessInfraFailure({ error: "all Max accounts capped — awaiting reset" }), true);
});

test("isBlamelessInfraFailure: (d) 'no parseable verdict/decisions/learning' session-died → blameless", () => {
  assert.equal(isBlamelessInfraFailure({ error: "spec-review produced no parseable decisions" }), true);
  assert.equal(isBlamelessInfraFailure({ error: "the agent produced no parseable verdict after 3 attempts" }), true);
  assert.equal(isBlamelessInfraFailure({ error: "agent-coach — no parseable learning returned" }), true);
});

test("isBlamelessInfraFailure: (e) DB-down author-write fallout → blameless", () => {
  assert.equal(isBlamelessInfraFailure({ error: "silent author-write fallout — the write did not land" }), true);
  assert.equal(isBlamelessInfraFailure({ error: "spec did not persist to public.specs (author write returned no row)" }), true);
});

test("isBlamelessInfraFailure: parseable-but-wrong verdict is NOT blameless (worker judgment slip)", () => {
  assert.equal(isBlamelessInfraFailure({ error: "spec-review: needs_fix on a sound spec — wrong verdict" }), false);
  assert.equal(isBlamelessInfraFailure({ error: "regression: false-positive dismissal of a real bug" }), false);
  assert.equal(isBlamelessInfraFailure({ error: "misdiagnosed root-cause — symptom, not root" }), false);
  // Worker-attributable marker WINS over a co-occurring outage signature (protects against masking).
  assert.equal(
    isBlamelessInfraFailure({
      error: "authentication_failed",
      log_tail: "but then re-tried and produced wrong disposition on the ticket",
    }),
    false,
  );
});

test("isBlamelessInfraFailure: a clean success / empty job is NOT blameless", () => {
  assert.equal(isBlamelessInfraFailure({ error: null, log_tail: null }), false);
  assert.equal(isBlamelessInfraFailure({}), false);
  assert.equal(isBlamelessInfraFailure({ error: null, log_tail: "PR merged clean — build ok" }), false);
});

test("isBlamelessInfraFailure: matches on log_tail as well as error", () => {
  assert.equal(
    isBlamelessInfraFailure({ error: null, log_tail: "…\n[claude] authentication_failed\n" }),
    true,
  );
  assert.equal(
    isBlamelessInfraFailure({ error: null, log_tail: "silent author-write fallout in author-spec.ts" }),
    true,
  );
});

// ── Phase 2: grader-skip wiring — applyBoxGrade + AGENT_INFLIGHT_SKIP_REASONS ─────────────────────
//
// A blameless-infra job must NEVER become a 1-10 grade. The skip is silent (no console.error) and
// writes NO agent_action_grades row — mirroring the existing in-flight-race handling in the sweep.

/** Minimal admin-client fake — captures every mutation on `agent_action_grades` and returns a
 *  scripted response for the initial `.from('agent_jobs')` fetch + the existing-grade lookup.
 *  Sufficient to exercise applyBoxGrade's control flow without a real Supabase. */
type BoxGradeWrite = { table: string; op: "insert" | "update"; payload: Record<string, unknown> };
function makeGraderAdmin(jobRow: Record<string, unknown> | null, existingGrade: Record<string, unknown> | null = null): {
  admin: unknown;
  writes: BoxGradeWrite[];
} {
  const writes: BoxGradeWrite[] = [];
  const admin = {
    from(table: string) {
      const single = async () => {
        if (table === "agent_jobs") return { data: jobRow };
        if (table === "agent_action_grades") return { data: existingGrade };
        return { data: null };
      };
      const chain = {
        select: (_cols?: string) => chain,
        eq: (_col: string, _val: unknown) => chain,
        maybeSingle: single,
        single,
        insert(payload: Record<string, unknown>) {
          writes.push({ table, op: "insert", payload });
          return {
            select: (_c?: string) => ({
              single: async () => ({ data: { id: `new-${table}-id` }, error: null }),
            }),
          };
        },
        update(payload: Record<string, unknown>) {
          writes.push({ table, op: "update", payload });
          return chain;
        },
      };
      return chain;
    },
  };
  return { admin, writes };
}

/** Concluded blameless-infra job (CLI auth outage) — the 2026-07-08 poisoning shape. */
const BLAMELESS_JOB = {
  id: "job-blameless-1",
  workspace_id: "ws-1",
  kind: "build",
  spec_slug: "some-spec",
  status: "failed",
  error: "authentication_failed — CLAUDE_CONFIG_DIR credentials evicted mid-run",
  log_tail: "[claude] Please run /login to continue",
  pr_url: null,
  pending_actions: null,
  created_at: "2026-07-08T12:00:00Z",
};

/** Concluded WORKER failure — a real tsc break, not an outage. Must still grade. */
const REAL_FAIL_JOB = {
  id: "job-real-fail-1",
  workspace_id: "ws-1",
  kind: "build",
  spec_slug: "some-spec",
  status: "failed",
  error: "tsc failed: 3 type errors in src/lib/foo.ts",
  log_tail: "src/lib/foo.ts(42,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  pr_url: null,
  pending_actions: null,
  created_at: "2026-07-08T12:00:00Z",
};

test("applyBoxGrade: blameless-infra job → { ok:false, reason:'blameless_infra_failure' } and NO grade row written", async () => {
  const { admin, writes } = makeGraderAdmin(BLAMELESS_JOB);
  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const res = await applyBoxGrade({ agentJobId: BLAMELESS_JOB.id, grade: 2, reasoning: "outage failed the run", admin: admin as never });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "blameless_infra_failure");
    // NO writes to agent_action_grades — a blameless failure MUST NEVER become a 1-10 grade.
    const gradeWrites = writes.filter((w) => w.table === "agent_action_grades");
    assert.equal(gradeWrites.length, 0);
    // Silent skip — no console.error for the blameless case.
    assert.equal(errors.length, 0);
  } finally {
    console.error = origErr;
  }
});

test("applyBoxGrade: genuine worker failure (tsc break) still grades → one insert into agent_action_grades", async () => {
  const { admin, writes } = makeGraderAdmin(REAL_FAIL_JOB, null);
  const res = await applyBoxGrade({ agentJobId: REAL_FAIL_JOB.id, grade: 3, reasoning: "tsc failed — worker mistake", admin: admin as never });
  assert.equal(res.ok, true);
  assert.equal(res.grade, 3);
  const gradeInserts = writes.filter((w) => w.table === "agent_action_grades" && w.op === "insert");
  assert.equal(gradeInserts.length, 1);
  // The stored grade matches what the caller passed (clamped 1-10) — the normal path is unchanged.
  assert.equal((gradeInserts[0].payload as { grade: number }).grade, 3);
  assert.equal((gradeInserts[0].payload as { agent_job_id: string }).agent_job_id, REAL_FAIL_JOB.id);
});

test("AGENT_INFLIGHT_SKIP_REASONS: silences the sweep on the blameless-infra skip", () => {
  // gradeConcludedAgentActions decides whether to console.error a per-job skip based on this set.
  // Membership of 'blameless_infra_failure' is what makes the sweep silent (spec Verification —
  // "Confirm no console.error for the skip"), alongside the existing in-flight-race reasons.
  assert.equal(AGENT_INFLIGHT_SKIP_REASONS.has("blameless_infra_failure"), true);
  assert.equal(AGENT_INFLIGHT_SKIP_REASONS.has("not_concluded"), true);
  assert.equal(AGENT_INFLIGHT_SKIP_REASONS.has("job_not_found"), true);
  // A TRUE grader error must NOT be silenced — it still surfaces in the Vercel error feed.
  assert.equal(AGENT_INFLIGHT_SKIP_REASONS.has("parse_failed"), false);
  assert.equal(AGENT_INFLIGHT_SKIP_REASONS.has("grader_http_429"), false);
});

// ── Phase 3: coach ignores blameless history + self-heal reconcile ───────────────────────────────
//
// (1) The coach's low-grade window must EXCLUDE a reconciled blameless grade — its neutralized
//     state (grade=NULL) doesn't satisfy `< COACH_LOW_ROLLUP`, so `isInCoachLowGradeWindow` returns
//     false. This is what stops an already-cleared outage burst from re-parking needs_attention.
// (2) reconcileBlamelessGradePoison identifies + neutralizes the 2026-07-08 poison IDEMPOTENTLY —
//     dry-run flags matches, apply neutralizes them, a re-run over the same window is a no-op
//     (already-marked rows are skipped), and a real worker slip stays untouched.

test("matchedBlamelessInfraSignatureKey: returns the concrete pattern key that matched", () => {
  assert.equal(matchedBlamelessInfraSignatureKey({ error: "authentication_failed — creds expired" }), "cli_auth_failed");
  assert.equal(matchedBlamelessInfraSignatureKey({ error: "usage limit reached — all Max accounts capped (parked)" }), "all_max_accounts_capped");
  assert.equal(matchedBlamelessInfraSignatureKey({ error: "no parseable verdict returned after 3 attempts" }), "no_parseable_verdict");
  assert.equal(matchedBlamelessInfraSignatureKey({ error: "silent author-write fallout — spec did not persist" }), "silent_author_write_fallout");
  // (b) 0-token dead session — non-textual conjunction → the reserved key.
  assert.equal(
    matchedBlamelessInfraSignatureKey({ input_tokens: 0, output_tokens: 0, log_tail: "session ended with no output" }),
    "zero_token_dead_session",
  );
  // Worker-attributable and clean paths → null.
  assert.equal(matchedBlamelessInfraSignatureKey({ error: "regression: false-positive dismissal of a real bug" }), null);
  assert.equal(matchedBlamelessInfraSignatureKey({ error: "tsc failed: 3 type errors" }), null);
  assert.equal(matchedBlamelessInfraSignatureKey({}), null);
});

test("isInCoachLowGradeWindow: a reconciled blameless row (grade=NULL) is EXCLUDED — coach window count drops", () => {
  // The three-shape mirror of the SQL filter (`.not("grade", "is", null).lt("grade", 7)`) —
  // asserts the coach's low-grade window count excludes a blameless-reconciled grade AND that a
  // genuine low grade stays in the window.
  const rows = [
    { grade: 3 as number | null },  // genuine low grade → IN window
    { grade: null as number | null }, // reconciled blameless → EXCLUDED
    { grade: 8 as number | null },  // strong grade → EXCLUDED (above threshold)
    { grade: 2 as number | null },  // genuine low grade → IN window
  ];
  const inWindow = rows.filter(isInCoachLowGradeWindow);
  assert.equal(inWindow.length, 2);
  assert.deepEqual(inWindow.map((r) => r.grade), [3, 2]);
  // Verifies the spec's "coach window count excludes blameless jobs" invariant.
});

/** Reconcile fake admin — captures reads + writes over agent_action_grades + agent_jobs, so the
 *  reconcile's plan-then-apply flow is exercised end-to-end without a real Supabase. */
type ReconcileWrite = { table: string; op: "update"; payload: Record<string, unknown>; matchedId?: string };
function makeReconcileAdmin(opts: {
  grades: Array<{ id: string; workspace_id: string; agent_job_id: string; agent_kind: string; grade: number | null; reasoning: string | null; graded_by: string; created_at: string }>;
  jobs: Array<{ id: string; error: string | null; log_tail: string | null }>;
  workspaceId: string;
}): { admin: unknown; writes: ReconcileWrite[]; getGrades: () => typeof opts.grades } {
  const state = opts.grades.map((g) => ({ ...g }));
  const writes: ReconcileWrite[] = [];
  const admin = {
    from(table: string) {
      const filters: Array<{ kind: string; args: unknown[] }> = [];
      const chain = {
        select: (_cols?: string) => chain,
        eq: (col: string, val: unknown) => { filters.push({ kind: "eq", args: [col, val] }); return chain; },
        neq: (col: string, val: unknown) => { filters.push({ kind: "neq", args: [col, val] }); return chain; },
        lt: (col: string, val: unknown) => { filters.push({ kind: "lt", args: [col, val] }); return chain; },
        gte: (col: string, val: unknown) => { filters.push({ kind: "gte", args: [col, val] }); return chain; },
        is: (col: string, val: unknown) => { filters.push({ kind: "is", args: [col, val] }); return chain; },
        not: (col: string, op: string, val: unknown) => { filters.push({ kind: `not_${op}`, args: [col, val] }); return chain; },
        in: (col: string, vals: unknown[]) => { filters.push({ kind: "in", args: [col, vals] }); return chain; },
        order: (_col: string, _opts?: unknown) => chain,
        limit: (_n: number) => chain,
        maybeSingle: async () => ({ data: null }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: undefined as any, // never a promise unless awaited via .select / update pipeline
        // Read path — the reconcile awaits the whole builder as a promise on the SELECT
        update(payload: Record<string, unknown>) {
          const updateFilters = filters.slice();
          const buildChain = () => {
            const c: Record<string, unknown> = {};
            const rebuild = (): Record<string, unknown> => c;
            c.eq = (col: string, val: unknown) => { updateFilters.push({ kind: "eq", args: [col, val] }); return rebuild(); };
            c.neq = (col: string, val: unknown) => { updateFilters.push({ kind: "neq", args: [col, val] }); return rebuild(); };
            c.lt = (col: string, val: unknown) => { updateFilters.push({ kind: "lt", args: [col, val] }); return rebuild(); };
            c.not = (col: string, op: string, val: unknown) => { updateFilters.push({ kind: `not_${op}`, args: [col, val] }); return rebuild(); };
            c.select = (_c?: string) => Promise.resolve({ data: (() => {
              // Apply the filters + mutate state.
              const row = state.find((r) => {
                for (const f of updateFilters) {
                  if (f.kind === "eq" && (r as Record<string, unknown>)[f.args[0] as string] !== f.args[1]) return false;
                  if (f.kind === "neq" && (r as Record<string, unknown>)[f.args[0] as string] === f.args[1]) return false;
                  if (f.kind === "lt") {
                    const v = (r as Record<string, unknown>)[f.args[0] as string];
                    if (typeof v !== "number" || !(v < (f.args[1] as number))) return false;
                  }
                  if (f.kind === "not_is") {
                    const col = f.args[0] as string;
                    const arg = f.args[1];
                    if (arg === null && (r as Record<string, unknown>)[col] === null) return false;
                  }
                }
                return true;
              });
              if (!row) return [];
              Object.assign(row, payload);
              writes.push({ table, op: "update", payload, matchedId: row.id });
              return [{ id: row.id }];
            })() });
            return c;
          };
          return buildChain();
        },
      };
      // Terminal read: the reconcile awaits the builder — we return the filtered rows.
      const asPromise = new Promise<{ data: unknown[] }>((resolve) => {
        setImmediate(() => {
          if (table === "agent_action_grades") {
            const rows = state.filter((r) => {
              for (const f of filters) {
                if (f.kind === "eq" && (r as Record<string, unknown>)[f.args[0] as string] !== f.args[1]) return false;
                if (f.kind === "neq" && (r as Record<string, unknown>)[f.args[0] as string] === f.args[1]) return false;
                if (f.kind === "lt") {
                  const v = (r as Record<string, unknown>)[f.args[0] as string];
                  if (typeof v !== "number" || !(v < (f.args[1] as number))) return false;
                }
                if (f.kind === "gte") {
                  const v = (r as Record<string, unknown>)[f.args[0] as string];
                  if (typeof v !== "string" || !(v >= (f.args[1] as string))) return false;
                }
                if (f.kind === "not_is") {
                  const col = f.args[0] as string;
                  const arg = f.args[1];
                  if (arg === null && (r as Record<string, unknown>)[col] === null) return false;
                }
                if (f.kind === "not_ilike") {
                  const col = f.args[0] as string;
                  const pattern = f.args[1] as string;
                  const v = (r as Record<string, unknown>)[col];
                  if (typeof v === "string") {
                    // support prefix-marker pattern like `[BLAMELESS_INFRA]%` — anchor at start.
                    if (pattern.endsWith("%")) {
                      const prefix = pattern.slice(0, -1);
                      if (v.startsWith(prefix)) return false;
                    } else if (v === pattern) return false;
                  }
                }
              }
              return true;
            });
            resolve({ data: rows });
          } else if (table === "agent_jobs") {
            // in() filter matches on id
            const idsFilter = filters.find((f) => f.kind === "in" && f.args[0] === "id");
            const ids = new Set((idsFilter?.args[1] as unknown[]) ?? []);
            resolve({ data: opts.jobs.filter((j) => ids.has(j.id)) });
          } else {
            resolve({ data: [] });
          }
        });
      });
      (chain as unknown as { then: unknown }).then = asPromise.then.bind(asPromise);
      return chain;
    },
  };
  return { admin, writes, getGrades: () => state };
}

test("reconcileBlamelessGradePoison: dry-run identifies blameless grades WITHOUT writing", async () => {
  const { admin, writes } = makeReconcileAdmin({
    workspaceId: "ws-1",
    grades: [
      { id: "g1", workspace_id: "ws-1", agent_job_id: "j1", agent_kind: "build", grade: 2, reasoning: "build failed", graded_by: "agent", created_at: "2026-07-08T12:00:00Z" },
      { id: "g2", workspace_id: "ws-1", agent_job_id: "j2", agent_kind: "build", grade: 4, reasoning: "tsc failed", graded_by: "agent", created_at: "2026-07-08T12:05:00Z" },
    ],
    jobs: [
      { id: "j1", error: "authentication_failed — credentials evicted", log_tail: null },
      { id: "j2", error: "tsc failed: 3 type errors", log_tail: null },
    ],
  });
  const res = await reconcileBlamelessGradePoison({ workspaceId: "ws-1", admin: admin as never, apply: false });
  assert.equal(res.dryRun, true);
  assert.equal(res.considered, 2);
  assert.equal(res.matched, 1); // only g1 (j1 is blameless-infra)
  assert.equal(res.applied, 0); // dry-run writes nothing
  assert.equal(writes.length, 0);
  assert.equal(res.details[0].gradeId, "g1");
  assert.equal(res.details[0].matchedSignature, "cli_auth_failed");
  assert.equal(res.details[0].oldGrade, 2);
});

test("reconcileBlamelessGradePoison: apply neutralizes matched rows AND leaves the real slip untouched", async () => {
  const { admin, writes, getGrades } = makeReconcileAdmin({
    workspaceId: "ws-1",
    grades: [
      { id: "g1", workspace_id: "ws-1", agent_job_id: "j1", agent_kind: "build", grade: 2, reasoning: "build failed", graded_by: "agent", created_at: "2026-07-08T12:00:00Z" },
      { id: "g2", workspace_id: "ws-1", agent_job_id: "j2", agent_kind: "build", grade: 4, reasoning: "tsc failed", graded_by: "agent", created_at: "2026-07-08T12:05:00Z" },
    ],
    jobs: [
      { id: "j1", error: "authentication_failed — credentials evicted", log_tail: null },
      { id: "j2", error: "tsc failed: 3 type errors", log_tail: null },
    ],
  });
  const res = await reconcileBlamelessGradePoison({ workspaceId: "ws-1", admin: admin as never, apply: true });
  assert.equal(res.applied, 1);
  assert.equal(res.matched, 1);
  assert.equal(writes.length, 1);
  const updated = writes[0];
  assert.equal(updated.matchedId, "g1");
  assert.equal((updated.payload as { grade: number | null }).grade, null); // neutralized
  const newReasoning = (updated.payload as { reasoning: string }).reasoning;
  assert.ok(newReasoning.startsWith(BLAMELESS_INFRA_RECONCILE_MARKER)); // audit prefix
  assert.ok(newReasoning.includes("cli_auth_failed")); // matched signature
  assert.ok(newReasoning.includes("originally graded 2/10")); // original grade preserved
  // The real-slip row was NOT touched.
  const finalG2 = getGrades().find((g) => g.id === "g2");
  assert.equal(finalG2?.grade, 4);
});

test("reconcileBlamelessGradePoison: never touches a HUMAN-overridden grade", async () => {
  const { admin, writes } = makeReconcileAdmin({
    workspaceId: "ws-1",
    grades: [
      // A blameless-infra shaped row that a HUMAN already overrode — must be left alone.
      { id: "g-human", workspace_id: "ws-1", agent_job_id: "j-human", agent_kind: "build", grade: 2, reasoning: "CEO override", graded_by: "human", created_at: "2026-07-08T12:00:00Z" },
    ],
    jobs: [{ id: "j-human", error: "authentication_failed", log_tail: null }],
  });
  const res = await reconcileBlamelessGradePoison({ workspaceId: "ws-1", admin: admin as never, apply: true });
  assert.equal(res.considered, 0); // the human grade was filtered out at read time
  assert.equal(res.matched, 0);
  assert.equal(res.applied, 0);
  assert.equal(writes.length, 0);
});

test("reconcileBlamelessGradePoison: a re-run over the same window is IDEMPOTENT (already-marked rows skipped)", async () => {
  const { admin, writes } = makeReconcileAdmin({
    workspaceId: "ws-1",
    grades: [
      {
        id: "g1",
        workspace_id: "ws-1",
        agent_job_id: "j1",
        agent_kind: "build",
        // grade already NULL (a previous reconcile pass neutralized it)
        grade: null,
        reasoning: `${BLAMELESS_INFRA_RECONCILE_MARKER}[cli_auth_failed] originally graded 2/10 — build failed`,
        graded_by: "agent",
        created_at: "2026-07-08T12:00:00Z",
      },
    ],
    jobs: [{ id: "j1", error: "authentication_failed", log_tail: null }],
  });
  const res = await reconcileBlamelessGradePoison({ workspaceId: "ws-1", admin: admin as never, apply: true });
  // The `grade IS NOT NULL` guard alone would skip a re-run (grade is already null); belt-and-
  // suspenders, the marker-prefix guard would also skip it. Either way: considered=0, applied=0.
  assert.equal(res.considered, 0);
  assert.equal(res.applied, 0);
  assert.equal(writes.length, 0);
});
