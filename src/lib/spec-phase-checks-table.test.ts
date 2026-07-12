/**
 * Unit tests for machine-declared-verification Phase 1 — `validateExecutableCheck` + the read-only-SQL
 * guard `isPlainReadonlySql`. One accept + one reject per exec_kind. Pure functions — no DB.
 *
 *   npx tsx --test src/lib/spec-phase-checks-table.test.ts
 *
 * The unit_test path pins the durable rule: a script name absent from package.json rejects at authoring,
 * not at runtime — the exact rail that closes the cs-director `npm test` class the spec cites in § Why.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateExecutableCheck,
  isPlainReadonlySql,
  type SpecPhaseCheckExecKind,
} from "./spec-phase-checks-table";

test("validateExecutableCheck rejects a missing exec_kind", () => {
  const r = validateExecutableCheck({ exec_kind: null });
  assert.equal(r.valid, false);
  assert.match((r as { reason: string }).reason, /exec_kind is required/);
});

test("tsc / build accept null params + reject any params", () => {
  for (const kind of ["tsc", "build"] as SpecPhaseCheckExecKind[]) {
    assert.equal(validateExecutableCheck({ exec_kind: kind }).valid, true);
    assert.equal(validateExecutableCheck({ exec_kind: kind, params: null }).valid, true);
    const r = validateExecutableCheck({ exec_kind: kind, params: { anything: 1 } });
    assert.equal(r.valid, false, `${kind} should reject params`);
    assert.match((r as { reason: string }).reason, /takes no params/);
  }
});

test("needs_human accepts null params + never carries params", () => {
  assert.equal(validateExecutableCheck({ exec_kind: "needs_human" }).valid, true);
  const r = validateExecutableCheck({ exec_kind: "needs_human", params: { x: 1 } });
  assert.equal(r.valid, false);
  assert.match((r as { reason: string }).reason, /never auto-run/);
});

test("grep requires { pattern, expect } with expect in {present, absent}", () => {
  assert.equal(
    validateExecutableCheck({
      exec_kind: "grep",
      params: { pattern: "runSpecChecks", path: "src/lib", expect: "present" },
    }).valid,
    true,
  );
  const noPattern = validateExecutableCheck({ exec_kind: "grep", params: { expect: "present" } });
  assert.equal(noPattern.valid, false);
  assert.match((noPattern as { reason: string }).reason, /pattern/);
  const badExpect = validateExecutableCheck({
    exec_kind: "grep",
    params: { pattern: "x", expect: "maybe" },
  });
  assert.equal(badExpect.valid, false);
  assert.match((badExpect as { reason: string }).reason, /'present' or 'absent'/);
});

test("ci_status takes no params", () => {
  assert.equal(validateExecutableCheck({ exec_kind: "ci_status" }).valid, true);
  const r = validateExecutableCheck({ exec_kind: "ci_status", params: { branch: "main" } });
  assert.equal(r.valid, false);
  assert.match((r as { reason: string }).reason, /takes no params/);
});

test("http_get requires { url, expect_status } with a valid URL + HTTP status", () => {
  assert.equal(
    validateExecutableCheck({
      exec_kind: "http_get",
      params: { url: "https://shopcx.ai/roadmap", expect_status: 200 },
    }).valid,
    true,
  );
  const badUrl = validateExecutableCheck({
    exec_kind: "http_get",
    params: { url: "/roadmap", expect_status: 200 },
  });
  assert.equal(badUrl.valid, false);
  assert.match((badUrl as { reason: string }).reason, /full http\(s\)/);
  const badStatus = validateExecutableCheck({
    exec_kind: "http_get",
    params: { url: "https://x.example", expect_status: 99 },
  });
  assert.equal(badStatus.valid, false);
});

test("db_probe_readonly names a registered probe_id + binds workspace_id + rejects sensitive arg names", () => {
  // Happy path: a registered probe with all required args and a scalar expect.
  assert.equal(
    validateExecutableCheck({
      exec_kind: "db_probe_readonly",
      params: {
        probe_id: "spec_exists_by_slug",
        args: { workspace_id: "ws-1", slug: "spec-x" },
        expect: true,
      },
    }).valid,
    true,
  );
  // Reject: expect is required (may be null).
  const noExpect = validateExecutableCheck({
    exec_kind: "db_probe_readonly",
    params: { probe_id: "spec_exists_by_slug", args: { workspace_id: "ws-1", slug: "spec-x" } },
  });
  assert.equal(noExpect.valid, false);
  assert.match((noExpect as { reason: string }).reason, /expect is required/);
  // Reject: unknown probe_id — the constrained-registry rail. No free-form SQL is executable.
  const unknown = validateExecutableCheck({
    exec_kind: "db_probe_readonly",
    params: { probe_id: "delete_specs", expect: null },
  });
  assert.equal(unknown.valid, false);
  assert.match((unknown as { reason: string }).reason, /not a registered probe/);
  // Reject: missing required arg for the registered probe (workspace_id).
  const missing = validateExecutableCheck({
    exec_kind: "db_probe_readonly",
    params: { probe_id: "spec_exists_by_slug", args: { slug: "spec-x" }, expect: true },
  });
  assert.equal(missing.valid, false);
  assert.match((missing as { reason: string }).reason, /missing required arg/);
  // Reject: arg name looks like a secret column — the denylist covers `*_encrypted`, `secret_`, `api_key`, `private_key`, `token`.
  for (const bad of ["api_key", "user_token", "session_token", "credentials_encrypted", "secret_id", "private_key"]) {
    const r = validateExecutableCheck({
      exec_kind: "db_probe_readonly",
      params: {
        probe_id: "spec_exists_by_slug",
        args: { workspace_id: "ws-1", slug: "spec-x", [bad]: "x" },
        expect: true,
      },
    });
    assert.equal(r.valid, false, `arg named '${bad}' must reject`);
    assert.match((r as { reason: string }).reason, /sensitive column/);
  }
  // Reject: object expect — probes return a scalar.
  const complexExpect = validateExecutableCheck({
    exec_kind: "db_probe_readonly",
    params: {
      probe_id: "spec_exists_by_slug",
      args: { workspace_id: "ws-1", slug: "spec-x" },
      expect: { rows: 1 },
    },
  });
  assert.equal(complexExpect.valid, false);
  assert.match((complexExpect as { reason: string }).reason, /null \| number \| boolean/);
});

test("unit_test rejects a script that is not in package.json (closes the cs-director npm test class)", () => {
  const packageScripts = new Set(["test:build-lifecycle", "test:cart-gifts"]);
  const ok = validateExecutableCheck(
    { exec_kind: "unit_test", params: { script: "test:build-lifecycle" } },
    { packageScripts },
  );
  assert.equal(ok.valid, true);
  const missing = validateExecutableCheck(
    { exec_kind: "unit_test", params: { script: "test" } },
    { packageScripts },
  );
  assert.equal(missing.valid, false);
  assert.match((missing as { reason: string }).reason, /not a package\.json script/);
  // No packageScripts context → shape is validated but the existence check is skipped.
  assert.equal(
    validateExecutableCheck({ exec_kind: "unit_test", params: { script: "anything" } }).valid,
    true,
  );
});

test("isPlainReadonlySql accepts SELECT + WITH; rejects chained + mutating statements", () => {
  assert.equal(isPlainReadonlySql("SELECT id FROM public.specs"), true);
  assert.equal(isPlainReadonlySql("with a as (select 1) select * from a"), true);
  assert.equal(isPlainReadonlySql("select 1;"), true);
  assert.equal(isPlainReadonlySql("SELECT 1; DROP TABLE specs"), false);
  assert.equal(isPlainReadonlySql("UPDATE specs SET slug='x'"), false);
  assert.equal(isPlainReadonlySql("truncate specs"), false);
  assert.equal(isPlainReadonlySql(""), false);
});
