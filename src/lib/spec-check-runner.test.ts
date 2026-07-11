/**
 * Unit tests for machine-declared-verification Phase 2 — `runSpecChecks` deterministic Node runner.
 * Pure / DI — every executor + the row loader is injected so the tests run with no shell, no DB, no fetch.
 *
 *   npx tsx --test src/lib/spec-check-runner.test.ts
 *
 * Pins the four Phase-2 verification bullets:
 *   1. All-auto + machine-declared → pass/fail+evidence with NO LLM call; re-running is byte-identical.
 *   2. A mutating/undeclared check → needs_human, never executed.
 *   3. A command that does not exist (harness error) → needs_human, NEVER fail.
 *   4. Deterministic result shape: text, checkKey, verdict, category, evidence, exec_kind per check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runSpecChecks, type CheckExecutors, type LoadedCheck } from "./spec-check-runner";
import { checkKey } from "./spec-test-runs";

function makeExecutors(overrides: Partial<CheckExecutors> = {}): CheckExecutors {
  // Deterministic executor doubles — each records that it was called, returns a fixed { ok, evidence }.
  // The runner turns those into the check's verdict; the LLM is never invoked.
  const called = {
    tsc: 0,
    grep: 0,
    ci_status: 0,
    http_get: 0,
    db_probe_readonly: 0,
    unit_test: 0,
    build: 0,
  };
  const base: CheckExecutors = {
    tsc: async () => {
      called.tsc++;
      return { ok: true, evidence: "npx tsc --noEmit — 0 errors" };
    },
    grep: async ({ params }) => {
      called.grep++;
      const found = params.pattern === "PRESENT";
      return {
        ok: params.expect === "present" ? found : !found,
        evidence: `ripgrep '${params.pattern}' — ${found ? "1 match" : "0 matches"}`,
      };
    },
    ci_status: async () => {
      called.ci_status++;
      return { ok: true, evidence: "gh run — success" };
    },
    http_get: async ({ params }) => {
      called.http_get++;
      return {
        ok: params.expect_status === 200,
        evidence: `GET ${params.url} — 200`,
      };
    },
    db_probe_readonly: async ({ params }) => {
      called.db_probe_readonly++;
      return { ok: true, evidence: `probe(${params.sql}) — matched expect` };
    },
    unit_test: async ({ params }) => {
      called.unit_test++;
      return { ok: true, evidence: `npm run ${params.script} — exit 0` };
    },
    build: async () => {
      called.build++;
      return { ok: true, evidence: "next build — exit 0" };
    },
    ...overrides,
  };
  return Object.assign(base, { __called: called });
}

test("all-auto machine-declared spec — no LLM, byte-identical reruns", async () => {
  const checks: LoadedCheck[] = [
    { text: "tsc clean", exec_kind: "tsc", params: null },
    { text: "runner exported", exec_kind: "grep", params: { pattern: "PRESENT", path: "src/lib", expect: "present" } },
    { text: "roadmap 200s", exec_kind: "http_get", params: { url: "https://shopcx.ai/roadmap", expect_status: 200 } },
    { text: "probe rows", exec_kind: "db_probe_readonly", params: { sql: "select 1", expect: 1 } },
    { text: "unit_test passes", exec_kind: "unit_test", params: { script: "test:build-lifecycle" } },
  ];
  const packageScripts = new Set(["test:build-lifecycle"]);
  const executors = makeExecutors();
  const a = await runSpecChecks({
    workspaceId: "ws-1",
    slug: "spec-x",
    deps: { loadChecks: async () => checks, executors, packageScripts },
  });
  const b = await runSpecChecks({
    workspaceId: "ws-1",
    slug: "spec-x",
    deps: { loadChecks: async () => checks, executors, packageScripts },
  });
  assert.deepEqual(a.results, b.results, "reruns must be byte-identical given the same inputs");
  assert.equal(a.results.length, 5);
  for (const r of a.results) {
    assert.equal(r.verdict, "pass", `${r.text} should pass`);
    assert.equal(r.category, "auto");
    assert.ok(r.evidence.length > 0);
    // Deterministic: checkKey is a stable hash of the description.
    assert.equal(r.checkKey, checkKey(r.text));
  }
});

test("db_probe_readonly with a mutating sql — needs_human, executor is NEVER called", async () => {
  const checks: LoadedCheck[] = [
    { text: "sneaky delete", exec_kind: "db_probe_readonly", params: { sql: "delete from public.specs", expect: null } },
  ];
  const executors = makeExecutors();
  const called = (executors as CheckExecutors & { __called: Record<string, number> }).__called;
  const out = await runSpecChecks({
    workspaceId: "ws-1",
    slug: "spec-x",
    deps: { loadChecks: async () => checks, executors },
  });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].verdict, "needs_human");
  assert.equal(out.results[0].category, "needs_human");
  assert.match(out.results[0].evidence, /plain read-only SELECT/);
  assert.equal(called.db_probe_readonly, 0, "runner must not execute a rejected-by-validator check");
});

test("un-typed prose (exec_kind = null / undeclared) → needs_human, no executor call", async () => {
  const checks: LoadedCheck[] = [
    { text: "some prose the parser stamped", exec_kind: null, params: null },
    { text: "needs_human declared explicitly", exec_kind: "needs_human", params: null },
  ];
  const executors = makeExecutors();
  const called = (executors as CheckExecutors & { __called: Record<string, number> }).__called;
  const out = await runSpecChecks({
    workspaceId: "ws-1",
    slug: "spec-x",
    deps: { loadChecks: async () => checks, executors },
  });
  for (const r of out.results) {
    assert.equal(r.verdict, "needs_human");
    assert.equal(r.category, "needs_human");
  }
  const total = Object.values(called).reduce((a, b) => a + b, 0);
  assert.equal(total, 0, "no executor should run for undeclared / needs_human checks");
});

test("unit_test naming an unknown package.json script → needs_human at authoring (never runs)", async () => {
  const checks: LoadedCheck[] = [
    { text: "npm test", exec_kind: "unit_test", params: { script: "test" } },
  ];
  const packageScripts = new Set(["test:build-lifecycle", "test:cart-gifts"]);
  const executors = makeExecutors();
  const called = (executors as CheckExecutors & { __called: Record<string, number> }).__called;
  const out = await runSpecChecks({
    workspaceId: "ws-1",
    slug: "spec-x",
    deps: { loadChecks: async () => checks, executors, packageScripts },
  });
  assert.equal(out.results[0].verdict, "needs_human");
  assert.match(out.results[0].evidence, /not a package\.json script/);
  assert.equal(called.unit_test, 0);
});

test("HARNESS-signature failure (ENOENT / command not found) is downgraded to needs_human, NEVER fail", async () => {
  const checks: LoadedCheck[] = [
    { text: "grep for something", exec_kind: "grep", params: { pattern: "any", path: "src/lib", expect: "present" } },
  ];
  const executors = makeExecutors({
    grep: async () => ({
      ok: false,
      evidence: "spawn rg ENOENT: no such file or directory",
    }),
  });
  const out = await runSpecChecks({
    workspaceId: "ws-1",
    slug: "spec-x",
    deps: { loadChecks: async () => checks, executors },
  });
  assert.equal(out.results[0].verdict, "needs_human", "harness error must not become fail (2026-07-11 cs-director class)");
  assert.match(out.results[0].evidence, /harness/i);
});

test("a real assertion failure (executor returned ok:false with clean evidence) → fail", async () => {
  const checks: LoadedCheck[] = [
    { text: "grep for present pattern", exec_kind: "grep", params: { pattern: "MISSING", expect: "present" } },
  ];
  const executors = makeExecutors();
  const out = await runSpecChecks({
    workspaceId: "ws-1",
    slug: "spec-x",
    deps: { loadChecks: async () => checks, executors },
  });
  assert.equal(out.results[0].verdict, "fail");
  assert.match(out.results[0].evidence, /0 matches/);
});

test("results are position-ordered + fully typed (text, checkKey, verdict, category, evidence, exec_kind)", async () => {
  const checks: LoadedCheck[] = [
    { text: "second", exec_kind: "tsc", params: null },
    { text: "first — but position 1", exec_kind: "build", params: null },
  ];
  const executors = makeExecutors();
  const out = await runSpecChecks({
    workspaceId: "ws-1",
    slug: "spec-x",
    deps: { loadChecks: async () => checks, executors },
  });
  assert.equal(out.results.length, 2);
  for (const r of out.results) {
    assert.equal(typeof r.text, "string");
    assert.equal(typeof r.checkKey, "string");
    assert.ok(["pass", "fail", "needs_human"].includes(r.verdict));
    assert.ok(["auto", "needs_human"].includes(r.category));
    assert.ok(typeof r.evidence === "string");
    assert.ok(r.exec_kind === null || typeof r.exec_kind === "string");
  }
});
