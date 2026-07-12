/**
 * Unit tests for the constrained DB probe registry — pins the invariants that close the
 * 5 pre-merge Vault findings on spec-check-runner.ts:320/325/332
 * (injection · secret_leak · authz_rls · unsafe_admin_client · crypto_encrypted).
 *
 *   npx tsx --test src/lib/spec-check-db-probes.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DB_PROBES,
  SENSITIVE_COLUMN_PATTERN,
  assertRegistryInvariants,
  containsSensitiveColumn,
  isRegisteredProbe,
  listRegisteredProbes,
} from "./spec-check-db-probes";

test("registry is non-empty + every entry passes the load-time invariants", () => {
  const ids = listRegisteredProbes();
  assert.ok(ids.length > 0, "registry must expose at least one probe for the auto-testable path");
  assertRegistryInvariants(); // throws on a bad entry — we assert it does not throw here
});

test("isRegisteredProbe accepts registry entries + rejects arbitrary strings", () => {
  for (const id of listRegisteredProbes()) {
    assert.equal(isRegisteredProbe(id), true);
  }
  assert.equal(isRegisteredProbe("delete_from_specs"), false);
  assert.equal(isRegisteredProbe(""), false);
  assert.equal(isRegisteredProbe("__proto__"), false);
});

test("every requiresWorkspaceId=true probe binds workspace_id via requiredArgs", () => {
  for (const [id, def] of Object.entries(DB_PROBES)) {
    if (!def.requiresWorkspaceId) continue;
    assert.ok(
      def.requiredArgs.includes("workspace_id"),
      `probe '${id}' is tenant-scoped but does not require 'workspace_id' — RLS-bypass risk`,
    );
  }
});

test("no probe declares a sensitive-looking arg name (encrypted / secret / token / api_key / private_key)", () => {
  for (const [id, def] of Object.entries(DB_PROBES)) {
    for (const arg of def.requiredArgs) {
      assert.equal(
        containsSensitiveColumn(arg),
        false,
        `probe '${id}' declares a sensitive-looking arg '${arg}' — denylisted`,
      );
    }
  }
});

test("containsSensitiveColumn catches the documented patterns", () => {
  for (const bad of [
    "credentials_encrypted",
    "app_secret",
    "api_key",
    "user_api_key",
    "private_key",
    "session_token",
    "auth_token",
    "secret_id",
  ]) {
    assert.equal(containsSensitiveColumn(bad), true, `${bad} should match`);
  }
  for (const ok of ["workspace_id", "slug", "phase_id", "customer_id", "position"]) {
    assert.equal(containsSensitiveColumn(ok), false, `${ok} should NOT match`);
  }
});

test("SENSITIVE_COLUMN_PATTERN is a RegExp — kept exported for callers that need to layer their own denylist", () => {
  assert.ok(SENSITIVE_COLUMN_PATTERN instanceof RegExp);
});
