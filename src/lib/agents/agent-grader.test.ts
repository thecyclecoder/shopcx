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
  GRADE_BATCH_CAP,
  GRADE_CADENCE_MS,
  applyBoxGrade,
  isBlamelessInfraFailure,
  isInfraCancelledError,
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
