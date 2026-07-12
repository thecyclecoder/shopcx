/**
 * Unit tests for the every-spec-writer-authors-machine-runnable-verifications Phase 3 backfill
 * classifier. Pure function — no DB. Run:
 *   npx tsx --test scripts/backfill-spec-checks-to-typed.test.ts
 *
 * Locked invariants:
 *   1. tsc / build / ci_status prose maps to the typed exec_kind with null params.
 *   2. `npm run <script>` with a script that IS in package.json maps to unit_test; a script that
 *      ISN'T in the passed set stays needs_human (the runner would reject it at author time
 *      anyway — see validateExecutableCheck).
 *   3. A prose http_get with a full URL + a nearby integer status maps to http_get.
 *   4. Grep prose does NOT auto-promote (a prose "grep for the new resolver" doesn't literally
 *      name the token to search for — that's a fabrication risk).
 *   5. db_probe_readonly prose does NOT auto-promote (probe_id must come from the registered
 *      allowlist; matching prose against it fabricates).
 *   6. Truly ambiguous prose stays needs_human (safe direction — nothing auto-runs on it).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyProseCheck } from "./backfill-spec-checks-to-typed";

const NO_SCRIPTS = new Set<string>();
const REAL_SCRIPTS = new Set<string>(["test:unit", "check:types", "build"]);

test("tsc: 'npx tsc --noEmit' → tsc / null", () => {
  const r = classifyProseCheck("On the branch, `npx tsc --noEmit` → expect clean.", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "tsc");
  assert.equal(r.params, null);
});

test("tsc: bare 'tsc clean' → tsc", () => {
  const r = classifyProseCheck("tsc clean", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "tsc");
});

test("build: 'next build passes' → build", () => {
  const r = classifyProseCheck("next build passes", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "build");
});

test("build: 'npm run build' → build", () => {
  const r = classifyProseCheck("On the repo, npm run build → clean.", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "build");
});

test("ci_status: 'CI is green' → ci_status", () => {
  const r = classifyProseCheck("On the PR, CI is green.", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "ci_status");
});

test("ci_status: 'all CI checks pass' → ci_status", () => {
  const r = classifyProseCheck("all CI checks pass", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "ci_status");
});

test("unit_test: `npm run test:unit` with real script → unit_test {script}", () => {
  const r = classifyProseCheck("npm run test:unit → passes", { packageScripts: REAL_SCRIPTS });
  assert.equal(r.exec_kind, "unit_test");
  assert.deepEqual(r.params, { script: "test:unit" });
});

test("unit_test: `npm run test:missing` with UNKNOWN script → needs_human (safe fallback)", () => {
  const r = classifyProseCheck("npm run test:missing → passes", { packageScripts: REAL_SCRIPTS });
  assert.equal(r.exec_kind, "needs_human");
});

test("http_get: 'GET https://... returns 200' → http_get {url, expect_status}", () => {
  const r = classifyProseCheck("GET https://shopcx.ai/health returns 200", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "http_get");
  assert.deepEqual(r.params, { url: "https://shopcx.ai/health", expect_status: 200 });
});

test("http_get: 'curl https://foo/health' with no explicit status → default 200", () => {
  const r = classifyProseCheck("curl https://foo.example.com/health", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "http_get");
  assert.deepEqual(r.params, { url: "https://foo.example.com/health", expect_status: 200 });
});

test("http_get: 'GET url expects 404' → http_get with 404", () => {
  const r = classifyProseCheck("On the API, GET https://api.foo/nope expects 404.", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "http_get");
  assert.equal(r.params.expect_status, 404);
});

test("grep prose does NOT auto-promote (fabrication risk)", () => {
  const r = classifyProseCheck("grep for the new resolver in src/lib", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "needs_human");
});

test("db_probe prose does NOT auto-promote (probe_id must be from the registered allowlist)", () => {
  const r = classifyProseCheck("select count(*) from ticket_directions returns > 0", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "needs_human");
});

test("ambiguous prose stays needs_human (the safe direction — nothing auto-runs on it)", () => {
  const r = classifyProseCheck("verify the feature works end-to-end", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "needs_human");
  assert.equal(r.params, null);
});

test("empty description stays needs_human", () => {
  const r = classifyProseCheck("", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "needs_human");
});

test("whitespace-only stays needs_human", () => {
  const r = classifyProseCheck("   \n   ", { packageScripts: NO_SCRIPTS });
  assert.equal(r.exec_kind, "needs_human");
});

test("classifier is a pure function — same input yields the same output across calls", () => {
  const desc = "npx tsc --noEmit clean";
  const a = classifyProseCheck(desc, { packageScripts: NO_SCRIPTS });
  const b = classifyProseCheck(desc, { packageScripts: NO_SCRIPTS });
  assert.deepEqual(a, b);
});

test("classifier is safe on undefined context (defaults to empty packageScripts)", () => {
  const r = classifyProseCheck("npm run test:unit");
  assert.equal(r.exec_kind, "needs_human");
});
