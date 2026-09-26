/**
 * Static-assertion regression test for the director-grade approval_decisions select
 * (director-grade-approval-decision-select-schema-fix Phase 1).
 *
 * Named failing state we pin: the director-grade job path in scripts/builder-worker.ts must NOT
 * select a `director_function` column from public.approval_decisions — that column does not exist
 * on that table (the column with the same name lives on public.director_decision_grades; see
 * supabase/migrations/20260703120000_approval_decisions.sql). A regression that reintroduces
 * `director_function` into this specific select would put the box's director-grade job back into
 * the Postgres 42703 loop that motivated this fix.
 *
 *   npx tsx --test scripts/builder-worker.director-grade-approval-select.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";

const WORKER = readFileSync(join(__dirname, "builder-worker.ts"), "utf8");

/** The schema-safety fingerprint comment on the guarded read. */
const FINGERPRINT = "SCHEMA-SAFETY-FINGERPRINT: director-grade-approval-decisions-select";

test("director-grade approval_decisions read carries the schema-safety fingerprint", () => {
  assert.ok(
    WORKER.includes(FINGERPRINT),
    `expected the fingerprint comment '${FINGERPRINT}' on the guarded select — a rename/removal without updating this test is a red flag`,
  );
});

test("director-grade approval_decisions select does NOT reference director_function", () => {
  const idx = WORKER.indexOf(FINGERPRINT);
  assert.ok(idx >= 0, "fingerprint missing — the check above already failed");
  // Grab a window starting at the fingerprint through the next .maybeSingle() call — this is the
  // full guarded select expression.
  const tail = WORKER.slice(idx);
  const endIdx = tail.indexOf(".maybeSingle()");
  assert.ok(endIdx > 0, "could not locate .maybeSingle() terminator for the guarded select");
  const guardedSlice = tail.slice(0, endIdx);

  // The guarded select is a `.from("approval_decisions").select("…")` chain — extract the
  // exact select column list and assert `director_function` is not among it.
  const fromMatch = guardedSlice.match(/\.from\("approval_decisions"\)\s*\n?\s*\.select\("([^"]+)"\)/);
  assert.ok(fromMatch, "could not find the .from(\"approval_decisions\").select(...) chain under the fingerprint");
  const columns = fromMatch![1].split(",").map((c) => c.trim());
  assert.ok(!columns.includes("director_function"),
    `approval_decisions.director_function does not exist — remove it from the guarded select (current columns: ${columns.join(", ")})`);
  // Positive: the read still carries the columns the grader downstream needs.
  for (const required of ["id", "workspace_id", "agent_job_id", "reasoning", "created_at"]) {
    assert.ok(columns.includes(required),
      `guarded select must keep column '${required}' (current columns: ${columns.join(", ")})`);
  }
});

test("candidate.director_function is derived from candidate first, routed_to_function as fallback", () => {
  const idx = WORKER.indexOf(FINGERPRINT);
  const tail = WORKER.slice(idx);
  // The derivation line lives inside the same guarded block — bounded by the next `workspaceId =`
  // assignment so we don't sweep the whole file.
  const endIdx = tail.indexOf("workspaceId = workspaceId ??");
  assert.ok(endIdx > 0, "could not locate the workspaceId anchor after the guarded select");
  const block = tail.slice(0, endIdx);
  assert.ok(
    /c\.director_function\s*\|\|\s*decision\.routed_to_function\s*\|\|\s*"platform"/.test(block),
    "expected the fallback chain c.director_function || decision.routed_to_function || \"platform\" in the guarded block",
  );
});
