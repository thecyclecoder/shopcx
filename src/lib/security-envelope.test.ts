/**
 * Unit tests for the fused pre-merge security envelope's pure validator
 * ([[fused-premerge-security-authoritative-drop-standalone]] Phase 1). Pins the three shapes the
 * Phase-1 verification calls out:
 *
 *   1. envelope with `status:'clean'` but NO per-check evidence → classified `needs_human`;
 *   2. envelope with every checklist item marked clean + evidence strings → classified `clean`;
 *   3. envelope with one `finding` (file:line) → classified `not-clean`.
 *
 * Plus edge cases: missing envelope, empty checks array, partial coverage, finding-missing-location,
 * needs_human check, legacy flat findings array — all downgrade appropriately (bare/self-declared
 * clean can NEVER satisfy the pre-merge gate; a rubber-stamp is exactly what Phase 1 blocks).
 *
 * Pure helper — no I/O, no DB. Run:
 *   npm run test:security-envelope
 *   (= tsx --test src/lib/security-envelope.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFusedSecurityEnvelope,
  REQUIRED_SECURITY_CHECKS,
  type FusedSecurityEnvelope,
} from "./security-envelope";

/** helper: build a `clean` per-check entry for one key with the given evidence. */
const cleanCheck = (check: string, evidence: string) => ({ check, verdict: "clean" as const, evidence });

/** helper: an envelope where every REQUIRED check is clean-with-evidence. */
const allCleanWithEvidence = (): FusedSecurityEnvelope => ({
  status: "clean",
  review: "no findings; per-check evidence below",
  checks: REQUIRED_SECURITY_CHECKS.map((c) =>
    cleanCheck(c, `inspected the diff for ${c}: grepped changed files, no matches outside safe patterns`),
  ),
});

test("classifyFusedSecurityEnvelope: `status:'clean'` with NO structured checks array → needs_human (bare/self-declared — Phase 1 bullet 1)", () => {
  const bare = { status: "clean", review: "looks fine" };
  const v = classifyFusedSecurityEnvelope(bare);
  assert.equal(v.classification, "needs_human");
  assert.match(v.reason, /bare|no structured|self-declared/i);
});

test("classifyFusedSecurityEnvelope: every checklist item clean WITH evidence → clean (Phase 1 bullet 2)", () => {
  const v = classifyFusedSecurityEnvelope(allCleanWithEvidence());
  assert.equal(v.classification, "clean");
  assert.equal(v.findingCount, 0);
  assert.equal(v.findingMissingLocation, false);
  for (const c of v.perCheck) {
    assert.equal(c.verdict, "clean");
    assert.equal(c.hasEvidence, true);
  }
});

test("classifyFusedSecurityEnvelope: one `finding` with file:line + severity → not-clean (Phase 1 bullet 3)", () => {
  const env: FusedSecurityEnvelope = {
    status: "real-vuln",
    review: "one injection risk",
    checks: [
      {
        check: "injection",
        verdict: "finding",
        evidence: "raw string interpolation into a SQL fragment",
        location: "src/app/api/foo/route.ts:42",
        severity: "high",
      },
      ...REQUIRED_SECURITY_CHECKS.filter((k) => k !== "injection").map((c) =>
        cleanCheck(c, `inspected ${c}: no risk`),
      ),
    ],
  };
  const v = classifyFusedSecurityEnvelope(env);
  assert.equal(v.classification, "not-clean");
  assert.equal(v.findingCount, 1);
  assert.equal(v.findingMissingLocation, false);
});

test("classifyFusedSecurityEnvelope: null / missing envelope → needs_human", () => {
  const v = classifyFusedSecurityEnvelope(null);
  assert.equal(v.classification, "needs_human");
  assert.match(v.reason, /no security envelope/i);
});

test("classifyFusedSecurityEnvelope: envelope with `checks:[]` (empty array) → needs_human (still bare)", () => {
  const v = classifyFusedSecurityEnvelope({ status: "clean", checks: [] });
  assert.equal(v.classification, "needs_human");
  assert.match(v.reason, /bare|no structured|self-declared/i);
});

test("classifyFusedSecurityEnvelope: partial coverage (only 3 of 5 required checks) → needs_human, missing keys named", () => {
  const env: FusedSecurityEnvelope = {
    status: "clean",
    checks: [
      cleanCheck("injection", "grepped, safe"),
      cleanCheck("secret_leak", "no _encrypted plaintext"),
      cleanCheck("authz_rls", "no policy edits"),
    ],
  };
  const v = classifyFusedSecurityEnvelope(env);
  assert.equal(v.classification, "needs_human");
  assert.match(v.reason, /unsafe_admin_client/);
  assert.match(v.reason, /crypto_encrypted/);
});

test("classifyFusedSecurityEnvelope: `clean` verdicts WITHOUT evidence → needs_human (rubber-stamp guard)", () => {
  const env: FusedSecurityEnvelope = {
    status: "clean",
    checks: REQUIRED_SECURITY_CHECKS.map((c) => ({ check: c, verdict: "clean", evidence: "" })),
  };
  const v = classifyFusedSecurityEnvelope(env);
  assert.equal(v.classification, "needs_human");
  assert.match(v.reason, /without evidence|rubber-stamp/i);
});

test("classifyFusedSecurityEnvelope: any `needs_human` per-check entry → needs_human", () => {
  const env: FusedSecurityEnvelope = {
    status: "needs-human",
    checks: [
      cleanCheck("injection", "grepped, safe"),
      cleanCheck("secret_leak", "no leaks"),
      { check: "authz_rls", verdict: "needs_human", evidence: "policy change is ambiguous — need human review" },
      cleanCheck("unsafe_admin_client", "no exposure"),
      cleanCheck("crypto_encrypted", "no decrypt bypass"),
    ],
  };
  const v = classifyFusedSecurityEnvelope(env);
  assert.equal(v.classification, "needs_human");
  assert.match(v.reason, /needs_human[`\s]+per-check entry/i);
});

test("classifyFusedSecurityEnvelope: `finding` missing `location` still classifies not-clean AND flags the omission", () => {
  const env: FusedSecurityEnvelope = {
    status: "real-vuln",
    checks: [
      { check: "injection", verdict: "finding", evidence: "risk somewhere in the auth layer", severity: "medium" },
      ...REQUIRED_SECURITY_CHECKS.filter((k) => k !== "injection").map((c) => cleanCheck(c, `inspected ${c}`)),
    ],
  };
  const v = classifyFusedSecurityEnvelope(env);
  assert.equal(v.classification, "not-clean");
  assert.equal(v.findingMissingLocation, true);
});

test("classifyFusedSecurityEnvelope: legacy flat `findings` array (unstructured) treated as findings → not-clean", () => {
  const env: FusedSecurityEnvelope = {
    status: "clean",
    checks: REQUIRED_SECURITY_CHECKS.map((c) => cleanCheck(c, `inspected ${c}`)),
    findings: [{ file: "x.ts:1", detail: "something" }],
  };
  const v = classifyFusedSecurityEnvelope(env);
  assert.equal(v.classification, "not-clean");
  assert.equal(v.findingCount >= 1, true);
});

test("REQUIRED_SECURITY_CHECKS: exactly 5 keys and matches the prompt's checklist", () => {
  assert.deepEqual(
    [...REQUIRED_SECURITY_CHECKS],
    ["injection", "secret_leak", "authz_rls", "unsafe_admin_client", "crypto_encrypted"],
  );
});
