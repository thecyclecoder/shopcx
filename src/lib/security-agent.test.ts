/**
 * Unit test for the `isRealVulnVerdict` predicate that gates `completedClean` in the three security
 * rollup helpers (`getSecurityStateBySlug`, `getSecurityStateForSlug`, `getSecurityStateForBranch`).
 *
 * security-escalation-carries-fix-spec-or-one-click-author-action Fix 1 — a real-vuln finding whose
 * fix was auto-queued (or approved via the Phase-1 `author_fix_spec` action) lands its
 * security-review row at `status='completed'`. Before this fix, the rollups read `status` only, so a
 * known-vulnerable branch/spec read as `completedClean = true` and could satisfy the M4 promote /
 * fold gate. The predicate below is now the SOLE toggle that rejects those rows.
 *
 * Pure — no DB, no I/O. Run: `npx tsx --test src/lib/security-agent.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isRealVulnVerdict } from "./security-agent";

test("isRealVulnVerdict — the exact real-vuln string rejects completedClean", () => {
  assert.equal(isRealVulnVerdict("real-vuln"), true);
});

test("isRealVulnVerdict — case-insensitive + whitespace-tolerant (persisted-JSON tolerance)", () => {
  assert.equal(isRealVulnVerdict("REAL-VULN"), true);
  assert.equal(isRealVulnVerdict(" real-vuln "), true);
  assert.equal(isRealVulnVerdict("Real-Vuln"), true);
});

test("isRealVulnVerdict — clean / false-positive / needs-human never trigger", () => {
  assert.equal(isRealVulnVerdict("clean"), false);
  assert.equal(isRealVulnVerdict("false-positive"), false);
  assert.equal(isRealVulnVerdict("needs-human"), false);
});

test("isRealVulnVerdict — absent / null / undefined / empty is conservative-clean (legacy pre-verdict rows)", () => {
  assert.equal(isRealVulnVerdict(""), false);
  assert.equal(isRealVulnVerdict(null), false);
  assert.equal(isRealVulnVerdict(undefined), false);
});
