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
  mapFusedSecurityToVerdict,
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

// ── Phase 2 — mapFusedSecurityToVerdict (fused → applySecurityVerdictToJob verdict) ──
//
// The Phase-2 verification calls out this exact mapping — a clean-with-evidence classification MUST
// map to the "clean" verdict (the ONLY path to a `completed` gate-passing security-review row),
// and a needs_human downgrade MUST NOT map to "clean" (so a rubber-stamp strands the PR for a human,
// exactly as a missing dedicated review would).

test("mapFusedSecurityToVerdict: classification 'clean' → 'clean' (the only path to a `completedClean` row)", () => {
  assert.equal(mapFusedSecurityToVerdict("clean", "clean"), "clean");
  // Declared status is ignored when the classifier says clean — evidence, not the flag, wins.
  assert.equal(mapFusedSecurityToVerdict("clean", ""), "clean");
  assert.equal(mapFusedSecurityToVerdict("clean", "real-vuln"), "clean");
});

test("mapFusedSecurityToVerdict: classification 'needs_human' → 'needs-human' — NEVER 'clean' (rubber-stamp guard)", () => {
  // A Phase-1 downgrade must NOT read as clean — regardless of what the session declared.
  assert.equal(mapFusedSecurityToVerdict("needs_human", "clean"), "needs-human");
  assert.equal(mapFusedSecurityToVerdict("needs_human", "needs-human"), "needs-human");
  assert.equal(mapFusedSecurityToVerdict("needs_human", ""), "needs-human");
});

test("mapFusedSecurityToVerdict: classification 'not-clean' + declared 'real-vuln' → 'real-vuln' (auto-fix route)", () => {
  assert.equal(mapFusedSecurityToVerdict("not-clean", "real-vuln"), "real-vuln");
  // Case-insensitive on declared.
  assert.equal(mapFusedSecurityToVerdict("not-clean", "REAL-VULN"), "real-vuln");
});

// Fix 1 (check 0c7d55607fb43955) — regression: a finding + declared 'false-positive' USED TO map
// to 'false-positive', which applySecurityVerdictToJob records as `completed` (branch green). That
// violates the completedClean invariant (only clean-with-evidence may satisfy it). A session cannot
// find a real vulnerability and then wave it off as false-positive in the same envelope — the two
// contradict, so the safe answer is a human review, never a completed-green row.
test("mapFusedSecurityToVerdict: classification 'not-clean' + declared 'false-positive' → 'needs-human' (Fix 1 — completedClean invariant)", () => {
  // The heart of Fix 1: even when the session emits BOTH a real `finding` entry AND a top-level
  // status of "false-positive", we must NOT map to false-positive (which lands `completed`/green).
  // The finding + false-positive combination is either a session mistake or a rubber-stamp attempt;
  // the safe classification is needs-human.
  assert.equal(mapFusedSecurityToVerdict("not-clean", "false-positive"), "needs-human");
  // Case-insensitive on declared.
  assert.equal(mapFusedSecurityToVerdict("not-clean", "FALSE-POSITIVE"), "needs-human");
});

test("mapFusedSecurityToVerdict: classification 'not-clean' + unknown/empty/self-contradicting declared → 'needs-human' (fail-safe)", () => {
  assert.equal(mapFusedSecurityToVerdict("not-clean", ""), "needs-human");
  assert.equal(mapFusedSecurityToVerdict("not-clean", "gibberish"), "needs-human");
  // A session claiming `clean` while findings exist is not trusted — the finding wins, surfaces to a human.
  assert.equal(mapFusedSecurityToVerdict("not-clean", "clean"), "needs-human");
  // Same principle for needs-human declared — a finding is still a finding.
  assert.equal(mapFusedSecurityToVerdict("not-clean", "needs-human"), "needs-human");
});

test("Fix 1 end-to-end: envelope with a high-severity structured finding + declared 'false-positive' cannot satisfy completedClean", () => {
  // Exact scenario from the failing check evidence: a structured high-severity finding classified
  // `not-clean` by the pure validator, but the session declared status="false-positive". Before Fix 1,
  // the mapping returned "false-positive" (→ applySecurityVerdictToJob writes status='completed' →
  // getSecurityStateForBranch reports the branch green). After Fix 1, the mapping must return
  // "needs-human" so the branch is HELD for a human.
  const env: FusedSecurityEnvelope = {
    status: "false-positive",
    review: "session waved it off",
    checks: [
      {
        check: "injection",
        verdict: "finding",
        evidence: "raw string interpolation into a SQL fragment",
        location: "src/app/api/foo/route.ts:42",
        severity: "high",
      },
      ...REQUIRED_SECURITY_CHECKS.filter((k) => k !== "injection").map((c) => cleanCheck(c, `inspected ${c}: safe`)),
    ],
  };
  const info = classifyFusedSecurityEnvelope(env);
  assert.equal(info.classification, "not-clean");
  const applied = mapFusedSecurityToVerdict(info.classification, String(env.status));
  assert.notEqual(applied, "false-positive"); // ← the regression: cannot map to completed-green
  assert.notEqual(applied, "clean");
  assert.equal(applied, "needs-human"); // ← surfaces for a human, branch NOT green
});

test("mapFusedSecurityToVerdict + classifier: end-to-end mapping matches the Phase-2 verification bullets", () => {
  // (a) clean-with-evidence envelope → applied verdict 'clean' → getSecurityStateForBranch reads 'completed'.
  const cleanEnv: FusedSecurityEnvelope = {
    status: "clean",
    checks: REQUIRED_SECURITY_CHECKS.map((c) => ({
      check: c,
      verdict: "clean",
      evidence: `inspected ${c}: safe`,
    })),
  };
  const cleanClassification = classifyFusedSecurityEnvelope(cleanEnv);
  assert.equal(cleanClassification.classification, "clean");
  assert.equal(mapFusedSecurityToVerdict(cleanClassification.classification, String(cleanEnv.status)), "clean");

  // (b) Phase-1-downgraded envelope (session says "clean" but no per-check evidence) → 'needs-human'.
  const downgradedEnv = { status: "clean", review: "looks fine" };
  const downgradedClassification = classifyFusedSecurityEnvelope(downgradedEnv);
  assert.equal(downgradedClassification.classification, "needs_human");
  const downgradedVerdict = mapFusedSecurityToVerdict(
    downgradedClassification.classification,
    String((downgradedEnv as { status?: string }).status ?? ""),
  );
  assert.equal(downgradedVerdict, "needs-human");
  assert.notEqual(downgradedVerdict, "clean"); // ← the whole point of Phase 2.
});
