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
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, lstatSync, readFileSync as fsReadFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  runSpecChecks,
  classifyDeterministicRun,
  mergeDeterministicWithLlmChecks,
  buildGrepArgv,
  ensureRealTopLevelNodeModulesForBuild,
  type CheckExecutors,
  type LoadedCheck,
  type CheckResult,
} from "./spec-check-runner";
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
      return { ok: true, evidence: `probe(${params.probe_id}) — matched expect` };
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
    { text: "probe rows", exec_kind: "db_probe_readonly", params: { probe_id: "spec_exists_by_slug", args: { workspace_id: "ws-1", slug: "spec-x" }, expect: true } },
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

test("db_probe_readonly with an unknown probe_id — needs_human, executor is NEVER called", async () => {
  const checks: LoadedCheck[] = [
    // The old vulnerable shape (free-form sql) is no longer a valid payload — a spec that
    // authors a probe_id absent from the DB_PROBES registry falls through to needs_human,
    // never a fail, and the executor is not called. This is the constrained-registry path
    // that closes the 5 pre-merge Vault findings on spec-check-runner.ts:320/325/332.
    { text: "sneaky delete", exec_kind: "db_probe_readonly", params: { probe_id: "delete_from_specs", expect: null } },
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
  assert.match(out.results[0].evidence, /not a registered probe/);
  assert.equal(called.db_probe_readonly, 0, "runner must not execute a rejected-by-validator check");
});

test("db_probe_readonly with a sensitive-looking arg name — needs_human, executor is NEVER called", async () => {
  const checks: LoadedCheck[] = [
    // A defense-in-depth guard: even a registered probe rejects arg names that LOOK like a
    // secret column so a crafted spec can't smuggle an `*_encrypted` bind through the payload.
    {
      text: "sneaky secret bind",
      exec_kind: "db_probe_readonly",
      params: {
        probe_id: "spec_exists_by_slug",
        args: { workspace_id: "ws-1", slug: "spec-x", api_key: "leak-me" as unknown as string },
        expect: true,
      },
    },
  ];
  const executors = makeExecutors();
  const called = (executors as CheckExecutors & { __called: Record<string, number> }).__called;
  const out = await runSpecChecks({
    workspaceId: "ws-1",
    slug: "spec-x",
    deps: { loadChecks: async () => checks, executors },
  });
  assert.equal(out.results[0].verdict, "needs_human");
  assert.match(out.results[0].evidence, /sensitive column/);
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

// ── machine-declared-verification Phase 3 — merge policy ─────────────────────────────────────────
// The Vera lane's decision helper: skip Max when the runner resolved every check; otherwise merge the
// runner's authoritative pass/fail with the LLM's scoped residual. Pure — no DB, no LLM.

function makeResult(text: string, verdict: "pass" | "fail" | "needs_human"): CheckResult {
  return {
    text,
    checkKey: checkKey(text),
    verdict,
    category: verdict === "needs_human" ? "needs_human" : "auto",
    evidence: `${verdict} evidence`,
    exec_kind: verdict === "needs_human" ? "needs_human" : "tsc",
  };
}

test("classifyDeterministicRun — every pass → allResolved=true + approved + zero residual", () => {
  const cls = classifyDeterministicRun([makeResult("a", "pass"), makeResult("b", "pass")]);
  assert.equal(cls.allResolved, true, "all-auto passes must skip Max");
  assert.equal(cls.residualCount, 0);
  assert.equal(cls.agentVerdict, "approved");
  assert.equal(cls.summary.auto_pass, 2);
  assert.equal(cls.summary.needs_human, 0);
  assert.equal(cls.checks.length, 2);
});

test("classifyDeterministicRun — any needs_human → allResolved=false, LLM must handle residual", () => {
  const cls = classifyDeterministicRun([makeResult("a", "pass"), makeResult("b", "needs_human")]);
  assert.equal(cls.allResolved, false);
  assert.equal(cls.residualCount, 1);
  assert.deepEqual(cls.residualTexts, ["b"]);
  assert.equal(cls.agentVerdict, "needs_human", "any residual must NOT auto-approve");
});

test("classifyDeterministicRun — any fail → verdict=issues (fold gate must NOT run)", () => {
  const cls = classifyDeterministicRun([makeResult("a", "pass"), makeResult("b", "fail")]);
  assert.equal(cls.allResolved, true, "no needs_human residual still means allResolved=true");
  assert.equal(cls.agentVerdict, "issues");
  assert.equal(cls.summary.auto_fail, 1);
});

// ── no-machine-checks-auto-pass (CEO 2026-07-17) ─────────────────────────────────────────────────
// A spec with NO machine/auto checks has nothing for the deterministic runner to gate on → it must
// AUTO-PASS ('approved'), not 'needs_human'. Returning needs_human left such a spec permanently
// un-green (the auto-merge requires a green spec-test), so it could never self-merge — the 2026-07-17
// winners-flow stall (0 machine checks → needs_human → manual merge required).
test("classifyDeterministicRun — ZERO checks → approved (no machine tests to run, nothing to gate)", () => {
  const cls = classifyDeterministicRun([]);
  assert.equal(cls.agentVerdict, "approved", "an empty check set must auto-pass, not strand the spec on needs_human");
  assert.equal(cls.summary.auto_pass, 0);
  assert.equal(cls.summary.auto_fail, 0);
  assert.equal(cls.residualCount, 0);
});

test("classifyDeterministicRun — only needs_human checks + NO auto checks → approved (no machine tests)", () => {
  const cls = classifyDeterministicRun([makeResult("a", "needs_human"), makeResult("b", "needs_human")]);
  assert.equal(cls.agentVerdict, "approved", "no machine tests at all ⇒ auto-pass; human sign-off is the separate human-test column");
});

test("classifyDeterministicRun — a fail STILL wins even with no passing checks", () => {
  const cls = classifyDeterministicRun([makeResult("a", "fail")]);
  assert.equal(cls.agentVerdict, "issues", "a real machine failure must never be auto-passed");
});

test("classifyDeterministicRun — auto checks present + a residual → still needs_human (unchanged for real machine specs)", () => {
  const cls = classifyDeterministicRun([makeResult("a", "pass"), makeResult("b", "needs_human")]);
  assert.equal(cls.agentVerdict, "needs_human", "a spec that DOES run machine checks still surfaces an unresolved residual");
});

test("mergeDeterministicWithLlmChecks — runner pass wins over an LLM needs_human on the same bullet", () => {
  const runner: import("./spec-test-runs").SpecTestCheck[] = [
    { text: "the runner passed this", verdict: "pass", evidence: "runner ok" },
  ];
  const llm: import("./spec-test-runs").SpecTestCheck[] = [
    { text: "the runner passed this", verdict: "needs_human", evidence: "LLM said unclear" },
  ];
  const merged = mergeDeterministicWithLlmChecks(runner, llm);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].verdict, "pass");
  assert.equal(merged[0].evidence, "runner ok");
});

test("mergeDeterministicWithLlmChecks — runner needs_human is replaced by the LLM's scoped verdict", () => {
  const runner: import("./spec-test-runs").SpecTestCheck[] = [
    { text: "subjective bullet", verdict: "needs_human", evidence: "no exec_kind — undeclared prose" },
  ];
  const llm: import("./spec-test-runs").SpecTestCheck[] = [
    { text: "subjective bullet", verdict: "pass", evidence: "LLM confirmed" },
  ];
  const merged = mergeDeterministicWithLlmChecks(runner, llm);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].verdict, "pass", "the LLM residual must fill in the runner's needs_human");
  assert.equal(merged[0].evidence, "LLM confirmed");
});

test("mergeDeterministicWithLlmChecks — LLM only sees residual; drift LLM checks are appended, not silently dropped", () => {
  const runner: import("./spec-test-runs").SpecTestCheck[] = [
    { text: "a", verdict: "pass", evidence: "runner ok" },
    { text: "b (residual)", verdict: "needs_human", evidence: "no exec_kind" },
  ];
  const llm: import("./spec-test-runs").SpecTestCheck[] = [
    { text: "b (residual)", verdict: "pass", evidence: "LLM confirmed" },
    { text: "c (drifted — not in the residual scope)", verdict: "pass", evidence: "LLM added" },
  ];
  const merged = mergeDeterministicWithLlmChecks(runner, llm);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].text, "a");
  assert.equal(merged[1].text, "b (residual)");
  assert.equal(merged[1].verdict, "pass");
  assert.equal(merged[2].text, "c (drifted — not in the residual scope)");
});

test("buildGrepArgv places `--` before the user-controlled path (rg option-injection belt)", () => {
  // Regression pin for harden-deterministic-grep-check-paths: even a validator-passed path must
  // be argv-separated from the pattern by `--` so ripgrep cannot re-parse it as a flag or a
  // `--pre=`-style preprocessor. Pattern goes via `-e`; path goes after `--`; both are covered.
  const withPath = buildGrepArgv({ pattern: "PRESENT", path: "src/lib", expect: "present" });
  assert.deepEqual(withPath, ["-e", "PRESENT", "--", "src/lib"]);

  const noPath = buildGrepArgv({ pattern: "PRESENT", expect: "present" });
  assert.deepEqual(noPath, ["-e", "PRESENT", "--", "."]);

  // A pattern that itself starts with `-` still lands under `-e`, so rg treats it as data.
  const dashPattern = buildGrepArgv({ pattern: "-not-a-flag", path: "src/lib", expect: "present" });
  assert.equal(dashPattern[0], "-e");
  assert.equal(dashPattern[1], "-not-a-flag");
  assert.equal(dashPattern[2], "--");
  assert.equal(dashPattern[3], "src/lib");
});

test("ensureRealTopLevelNodeModulesForBuild — no-op when node_modules is already a real directory", async () => {
  const wt = mkdtempSync(joinPath(tmpdir(), "scr-nm-real-"));
  try {
    mkdirSync(joinPath(wt, "node_modules"));
    writeFileSync(joinPath(wt, "node_modules", "sentinel"), "hello");
    const r = await ensureRealTopLevelNodeModulesForBuild(wt);
    assert.equal(r.ok, true);
    assert.equal(r.action, "noop");
    // Real directory left untouched — sentinel still readable.
    assert.equal(fsReadFileSync(joinPath(wt, "node_modules", "sentinel"), "utf8"), "hello");
    assert.equal(lstatSync(joinPath(wt, "node_modules")).isSymbolicLink(), false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("ensureRealTopLevelNodeModulesForBuild — no-op when node_modules is absent", async () => {
  const wt = mkdtempSync(joinPath(tmpdir(), "scr-nm-none-"));
  try {
    const r = await ensureRealTopLevelNodeModulesForBuild(wt);
    assert.equal(r.ok, true);
    assert.equal(r.action, "noop");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("ensureRealTopLevelNodeModulesForBuild — materializes a real top-level dir when symlink points OUT of repoRoot (the Turbopack-panic shape)", async () => {
  const parent = mkdtempSync(joinPath(tmpdir(), "scr-nm-out-"));
  try {
    const shared = joinPath(parent, "shared-node_modules");
    const wt = joinPath(parent, "worktree");
    mkdirSync(shared);
    mkdirSync(joinPath(shared, "next"));
    writeFileSync(joinPath(shared, "next", "package.json"), '{"name":"next"}');
    mkdirSync(wt);
    symlinkSync(shared, joinPath(wt, "node_modules"));
    // Precondition: repoRoot/node_modules IS a symlink pointing OUT of repoRoot — the exact shape
    // scripts/builder-worker.ts creates for spec-test worktrees, and the exact shape Turbopack panics on.
    assert.equal(lstatSync(joinPath(wt, "node_modules")).isSymbolicLink(), true);

    const r = await ensureRealTopLevelNodeModulesForBuild(wt);
    assert.equal(r.ok, true, `expected ok — got evidence: ${r.evidence ?? ""}`);
    assert.equal(r.action, "materialized");

    // The top-level is now a REAL directory (Turbopack accepts this), and the hardlink-copy
    // preserved the shared tree's contents inside it.
    assert.equal(lstatSync(joinPath(wt, "node_modules")).isSymbolicLink(), false);
    assert.equal(lstatSync(joinPath(wt, "node_modules")).isDirectory(), true);
    assert.equal(
      fsReadFileSync(joinPath(wt, "node_modules", "next", "package.json"), "utf8"),
      '{"name":"next"}',
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureRealTopLevelNodeModulesForBuild — no-op when node_modules is a symlink to a sibling INSIDE repoRoot", async () => {
  const wt = mkdtempSync(joinPath(tmpdir(), "scr-nm-in-"));
  try {
    const real = joinPath(wt, "actual-nm");
    mkdirSync(real);
    writeFileSync(joinPath(real, "sentinel"), "hello");
    symlinkSync(real, joinPath(wt, "node_modules"));
    const r = await ensureRealTopLevelNodeModulesForBuild(wt);
    assert.equal(r.ok, true);
    assert.equal(r.action, "noop", "symlink resolves inside repoRoot — Turbopack accepts, do nothing");
    assert.equal(lstatSync(joinPath(wt, "node_modules")).isSymbolicLink(), true);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
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
