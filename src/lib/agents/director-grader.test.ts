/**
 * Unit tests for the director-grader sweep's `considered/graded` accounting
 * (grading-starved-counter-ignores-inflight-targets spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:director-grader
 *   (= tsx --test src/lib/agents/director-grader.test.ts)
 *
 * The accounting is extracted as `tallySweepResult(state, result)` so the tests can drive each of
 * the three scenarios the spec names — in-flight target, terminal+success, terminal+LLM error —
 * without stubbing Supabase or the LLM. The bug being fixed: the old loop did `considered++`
 * before calling `gradeAutoApproval`, so an in-flight target (correctly skipped by the grader
 * with `reason='not_concluded'`) still ticked the counter — making the grading-starved monitor
 * page whenever the director had open auto-approvals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  INFLIGHT_SKIP_REASONS,
  isInflightSkip,
  tallySweepResult,
  type DirectorGradeResult,
} from "./director-grader";

test("INFLIGHT_SKIP_REASONS contains the three skip reasons the spec names — and nothing else", () => {
  assert.deepEqual(new Set(INFLIGHT_SKIP_REASONS), new Set(["not_concluded", "no_target", "decision_not_found"]));
});

test("isInflightSkip: every named skip reason is a skip", () => {
  for (const reason of INFLIGHT_SKIP_REASONS) {
    assert.equal(isInflightSkip({ ok: false, reason }), true, `${reason} should be an in-flight skip`);
  }
});

test("isInflightSkip: ok results are never skips (even when idempotent)", () => {
  assert.equal(isInflightSkip({ ok: true, grade: 8 }), false);
  assert.equal(isInflightSkip({ ok: true, idempotent_update: true, grade: 8 }), false);
});

test("isInflightSkip: an LLM/HTTP/parse error is NOT a skip — genuine starvation must still page", () => {
  assert.equal(isInflightSkip({ ok: false, reason: "parse_failed" }), false);
  assert.equal(isInflightSkip({ ok: false, reason: "grader_http_500" }), false);
  assert.equal(isInflightSkip({ ok: false, reason: "no_api_key" }), false);
});

test("in-flight target (gradeAutoApproval returns not_concluded) ⇒ considered=0, graded=0", () => {
  const state = { considered: 0, graded: 0 };
  tallySweepResult(state, { ok: false, reason: "not_concluded" });
  assert.deepEqual(state, { considered: 0, graded: 0 });
});

test("terminal target with successful grade ⇒ considered=1, graded=1", () => {
  const state = { considered: 0, graded: 0 };
  const result: DirectorGradeResult = { ok: true, grade_id: "g1", dimension: "auto-approval", grade: 9 };
  tallySweepResult(state, result);
  assert.deepEqual(state, { considered: 1, graded: 1 });
});

test("terminal target with LLM error ⇒ considered=1, graded=0 (genuine starvation still pages)", () => {
  const state = { considered: 0, graded: 0 };
  tallySweepResult(state, { ok: false, reason: "parse_failed" });
  assert.deepEqual(state, { considered: 1, graded: 0 });
});

test("idempotent re-grade (row already graded by agent) ⇒ considered=1, graded=0 (no double-count)", () => {
  const state = { considered: 0, graded: 0 };
  tallySweepResult(state, { ok: true, grade_id: "g1", dimension: "auto-approval", grade: 8, idempotent_update: true });
  assert.deepEqual(state, { considered: 1, graded: 0 });
});

test("mixed sweep — 2 in-flight + 1 terminal+ok + 1 terminal+error ⇒ considered=2, graded=1", () => {
  const state = { considered: 0, graded: 0 };
  tallySweepResult(state, { ok: false, reason: "not_concluded" });
  tallySweepResult(state, { ok: false, reason: "not_concluded" });
  tallySweepResult(state, { ok: true, grade_id: "g1", dimension: "auto-approval", grade: 7 });
  tallySweepResult(state, { ok: false, reason: "grader_http_500" });
  assert.deepEqual(state, { considered: 2, graded: 1 });
});

test("the original bug scenario — 2 in-flight + 0 terminal ⇒ considered=0 (was =2 pre-fix, which paged)", () => {
  // Pre-fix: considered=2, graded=0 → 2 consecutive sweeps → loop_alert opens (false-positive).
  // Post-fix: considered=0, graded=0 → starved flag stays clear; monitor only fires on REAL starvation.
  const state = { considered: 0, graded: 0 };
  tallySweepResult(state, { ok: false, reason: "not_concluded" });
  tallySweepResult(state, { ok: false, reason: "not_concluded" });
  assert.deepEqual(state, { considered: 0, graded: 0 });
});

// ── Phase 7/Fix-2 (check 74b737bdbda6fa8d) — destructive-action grading rail ────
//
// A destructive-action approval is decided_by='ceo' but carries a
// `deterministic-raise-marker` row anchored to the approval_decisions row. The picker
// must re-surface it as an ungraded candidate (marker != real grade), and
// applyBoxDirectorGrade must accept the marker-anchored ceo path (the director-decided
// gate would otherwise reject with `not_a_director_approval` and starve the rail).

import { pickDirectorGradeBatch, applyBoxDirectorGrade } from "./director-grader";

/** Minimal Supabase-JS-style stub — supports the chain shapes both functions call. The
 *  Supabase JS filter chain is thenable (a bare `await .in(...)` resolves to {data, error}),
 *  so StubQuery implements `.then` so the same chain shape works here. */
type StubResp = { data: unknown; error: unknown };
type StubQuery = {
  eq(col: string, val: unknown): StubQuery;
  in(col: string, vals: unknown[]): StubQuery;
  order(col: string, opts?: unknown): StubQuery;
  limit(n: number): StubQuery;
  range(from: number, to: number): Promise<StubResp>;
  maybeSingle(): Promise<StubResp>;
  single(): Promise<StubResp>;
  then<T = StubResp>(resolve: (v: StubResp) => T): Promise<T>;
};

function makeStub(rows: {
  director_decision_grades?: Array<Record<string, unknown>>;
  approval_decisions?: Array<Record<string, unknown>>;
  agent_jobs?: Array<Record<string, unknown>>;
}): { admin: unknown; updates: Array<{ table: string; patch: Record<string, unknown>; where: Record<string, unknown> }>; inserts: Array<{ table: string; payload: Record<string, unknown> }> } {
  const updates: Array<{ table: string; patch: Record<string, unknown>; where: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const registries: Record<string, Array<Record<string, unknown>>> = {
    director_decision_grades: rows.director_decision_grades || [],
    approval_decisions: rows.approval_decisions || [],
    agent_jobs: rows.agent_jobs || [],
  };
  function buildQuery(table: string, filters: Array<{ kind: "eq" | "in"; col: string; val: unknown }>): StubQuery {
    const filtered = () =>
      registries[table].filter((r) =>
        filters.every((f) =>
          f.kind === "eq"
            ? (r as Record<string, unknown>)[f.col] === f.val
            : Array.isArray(f.val) && (f.val as unknown[]).includes((r as Record<string, unknown>)[f.col]),
        ),
      );
    const q: StubQuery = {
      eq(col: string, val: unknown) { filters.push({ kind: "eq", col, val }); return q; },
      in(col: string, vals: unknown[]) { filters.push({ kind: "in", col, val: vals }); return q; },
      order() { return q; },
      limit() { return q; },
      async range(_from: number, _to: number): Promise<StubResp> { return { data: filtered(), error: null }; },
      async maybeSingle(): Promise<StubResp> { return { data: filtered()[0] ?? null, error: null }; },
      async single(): Promise<StubResp> { const r = filtered()[0]; return { data: r ?? null, error: r ? null : { message: "no row" } }; },
      // Supabase's filter chain is thenable — `await .in(...)` resolves to {data, error}. When the
      // caller doesn't terminate with .range()/.maybeSingle()/.single(), a bare await falls through
      // this .then() and gets the full filtered list.
      then<T = StubResp>(resolve: (v: StubResp) => T): Promise<T> {
        return Promise.resolve(resolve({ data: filtered(), error: null }));
      },
    };
    return q;
  }
  const admin = {
    from(table: string) {
      return {
        select(_cols: string) { return buildQuery(table, []); },
        insert(payload: Record<string, unknown>) {
          inserts.push({ table, payload });
          const id = `stub-${table}-${inserts.length}`;
          registries[table].push({ ...payload, id });
          return {
            select() { return { async maybeSingle() { return { data: { id }, error: null }; }, async single() { return { data: { id }, error: null }; } }; },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(col: string, val: unknown) {
              updates.push({ table, patch, where: { [col]: val } });
              const target = registries[table].find((r) => (r as Record<string, unknown>)[col] === val);
              if (target) Object.assign(target, patch);
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  };
  return { admin, updates, inserts };
}

test("pickDirectorGradeBatch: a destructive-action marker row on a terminal target surfaces as an auto-approval candidate", async () => {
  // A ceo-decided destructive approval with a marker row anchored to it.
  const { admin } = makeStub({
    director_decision_grades: [{
      dimension: "auto-approval",
      approval_decision_id: "dec-destructive",
      goal_slug: null,
      milestone: null,
      model: "deterministic-raise-marker",
      director_function: "platform",
      workspace_id: "ws-1",
    }],
    approval_decisions: [{
      id: "dec-destructive",
      agent_job_id: "job-destructive",
      routed_to_function: "ceo",
      workspace_id: "ws-1",
      decided_by: "ceo",
      decision: "approved",
      autonomous: false,
    }],
    agent_jobs: [{ id: "job-destructive", status: "completed" }],
  });

  const batch = await pickDirectorGradeBatch({ workspaceId: "ws-1", admin: admin as unknown as Parameters<typeof pickDirectorGradeBatch>[0]["admin"] });
  const autoApprovals = batch.filter((c) => c.dimension === "auto-approval");
  assert.equal(autoApprovals.length, 1, "the marker-anchored destructive approval must be a candidate");
  assert.equal(autoApprovals[0].dimension === "auto-approval" && autoApprovals[0].approval_decision_id, "dec-destructive");
  assert.equal(autoApprovals[0].director_function, "platform", "director_function comes from the marker row, not the CEO fallback");
});

test("pickDirectorGradeBatch: a marker row whose target build is still in-flight is NOT surfaced (terminal-gated)", async () => {
  const { admin } = makeStub({
    director_decision_grades: [{
      dimension: "auto-approval",
      approval_decision_id: "dec-destructive",
      goal_slug: null,
      milestone: null,
      model: "deterministic-raise-marker",
      director_function: "platform",
      workspace_id: "ws-1",
    }],
    approval_decisions: [{
      id: "dec-destructive",
      agent_job_id: "job-destructive",
      routed_to_function: "ceo",
      workspace_id: "ws-1",
      decided_by: "ceo",
      decision: "approved",
      autonomous: false,
    }],
    agent_jobs: [{ id: "job-destructive", status: "queued" }],
  });

  const batch = await pickDirectorGradeBatch({ workspaceId: "ws-1", admin: admin as unknown as Parameters<typeof pickDirectorGradeBatch>[0]["admin"] });
  assert.equal(batch.filter((c) => c.dimension === "auto-approval").length, 0, "an in-flight target defers to the next beat");
});

test("pickDirectorGradeBatch: a marker row with a REAL grade already applied (model != marker) is NOT re-surfaced", async () => {
  // Simulate a marker row that the box sweep has already upgraded into a real grade —
  // the model column flipped from 'deterministic-raise-marker' to 'box-max-session'.
  const { admin } = makeStub({
    director_decision_grades: [{
      dimension: "auto-approval",
      approval_decision_id: "dec-destructive",
      goal_slug: null,
      milestone: null,
      model: "box-max-session",
      director_function: "platform",
      workspace_id: "ws-1",
    }],
    approval_decisions: [{
      id: "dec-destructive",
      agent_job_id: "job-destructive",
      routed_to_function: "ceo",
      workspace_id: "ws-1",
      decided_by: "ceo",
      decision: "approved",
      autonomous: false,
    }],
    agent_jobs: [{ id: "job-destructive", status: "completed" }],
  });

  const batch = await pickDirectorGradeBatch({ workspaceId: "ws-1", admin: admin as unknown as Parameters<typeof pickDirectorGradeBatch>[0]["admin"] });
  assert.equal(batch.filter((c) => c.dimension === "auto-approval").length, 0, "a truly-graded row must not re-surface");
});

test("applyBoxDirectorGrade: a ceo-decided approval WITH a marker row is graded (upserts in place); the director-decided gate no longer starves it", async () => {
  const { admin, updates } = makeStub({
    director_decision_grades: [{
      id: "marker-1",
      dimension: "auto-approval",
      approval_decision_id: "dec-destructive",
      goal_slug: null,
      milestone: null,
      model: "deterministic-raise-marker",
      director_function: "platform",
      graded_by: "agent",
      grade: null,
      workspace_id: "ws-1",
    }],
    approval_decisions: [{
      id: "dec-destructive",
      agent_job_id: "job-destructive",
      workspace_id: "ws-1",
      decided_by: "ceo",
      decision: "approved",
      autonomous: false,
    }],
    agent_jobs: [{ id: "job-destructive", status: "completed" }],
  });

  const r = await applyBoxDirectorGrade({
    dimension: "auto-approval",
    workspaceId: "ws-1",
    directorFunction: "platform",
    approvalDecisionId: "dec-destructive",
    grade: 8,
    reasoning: "raise was sound; blast-radius bounded",
    admin: admin as unknown as Parameters<typeof applyBoxDirectorGrade>[0]["admin"],
  });
  assert.equal(r.ok, true, `expected ok:true, got ${JSON.stringify(r)}`);
  assert.equal(r.dimension, "auto-approval");
  assert.equal(r.grade, 8);
  assert.equal(r.grade_id, "marker-1", "the marker row is upserted in place, not duplicated");
  assert.equal(updates.length, 1, "exactly one UPDATE on the marker row");
  assert.equal((updates[0].patch as { model?: string }).model, "box-max-session", "model flips from marker to the box-session stamp");
});

test("applyBoxDirectorGrade: a ceo-decided approval WITHOUT a marker row is still rejected (unchanged for non-destructive ceo overrides)", async () => {
  const { admin } = makeStub({
    director_decision_grades: [],
    approval_decisions: [{
      id: "dec-nondestr",
      agent_job_id: "job-x",
      workspace_id: "ws-1",
      decided_by: "ceo",
      decision: "approved",
      autonomous: false,
    }],
    agent_jobs: [{ id: "job-x", status: "completed" }],
  });

  const r = await applyBoxDirectorGrade({
    dimension: "auto-approval",
    workspaceId: "ws-1",
    directorFunction: "platform",
    approvalDecisionId: "dec-nondestr",
    grade: 8,
    reasoning: "n/a",
    admin: admin as unknown as Parameters<typeof applyBoxDirectorGrade>[0]["admin"],
  });
  assert.equal(r.ok, false, "a ceo-decided approval with NO marker row still isn't a director-decision grade");
  assert.equal(r.reason, "not_a_director_approval");
});
