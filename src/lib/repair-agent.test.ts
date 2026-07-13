/**
 * repair-agent tests — retire-md-spec-writers-db-is-sole-spec Phase 2 (repair lane).
 *
 * Durable contracts:
 *
 *   A) `buildRepairSpecInput` returns a [[../libraries/author-spec]] `StructuredSpecInput` — NOT
 *      markdown — so `runRepairJob` authors via `authorSpecRowStructured`. Every phase carries at
 *      least one typed `exec_kind`-declared machine check (at minimum a tsc check; when the
 *      proposal names a `target` file AND a fingerprint the derived defaults add a grep check on
 *      that file) so the deterministic spec-check runner can verify the fix landed — no more
 *      prose-only phases that would fail `assertEveryPhaseHasMachineCheck` and park at the CEO
 *      inbox (the appstle / meta-ads / subscription-items / internal-renewal class Phase 2 kills).
 *
 *   B) When Rafa emits `phases[]` with typed `checks[]`, the helper PREFERS those over derived
 *      defaults so the repair author path can carry a grep for the exact guard/fix Rafa proposes
 *      (the LLM knows the fingerprint; the helper does not).
 *
 *   C) `parseRepairSpecMeta` still round-trips the machine markers — the helper preserves
 *      `**Repair-root-cause:**` / `**Repair-signature:**` in the phase 1 body, so
 *      `groupOrAuthorRepairSpec` root-cause grouping keeps working after the structured switch.
 *
 * Run: npx tsx --test src/lib/repair-agent.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRepairSpecInput,
  derivedDefaultRepairChecks,
  normalizeImplicatedFile,
  parseRepairSpecMeta,
  REPAIR_FIX_PARENT_KIND,
  REPAIR_FIX_PARENT_PROSE,
  REPAIR_FIX_PARENT_REF,
  rootCauseKey,
} from "./repair-agent";
import { assertEveryPhaseHasMachineCheck } from "./author-spec";
import type { SpecPhaseCheckInput } from "./spec-phase-checks-table";

test("derivedDefaultRepairChecks: always emits a tsc check; adds grep only when target + fingerprint are both known", () => {
  // Bare — no target: a single tsc check. Never fabricates a grep against a fake path.
  const bare = derivedDefaultRepairChecks({ target: null });
  assert.equal(bare.length, 1);
  assert.equal(bare[0].exec_kind, "tsc");
  assert.equal(bare[0].kind, "auto");
  assert.equal(bare[0].params, null);

  // Target known but no fingerprint — still only tsc (never fabricate a pattern).
  const targetOnly = derivedDefaultRepairChecks({ target: "src/lib/foo.ts" });
  assert.equal(targetOnly.length, 1);
  assert.equal(targetOnly[0].exec_kind, "tsc");

  // Target + fingerprint — adds a grep check on the normalized target path.
  const both = derivedDefaultRepairChecks({ target: "src/lib/foo.ts", fingerprint: "guardBar" });
  assert.equal(both.length, 2);
  assert.equal(both[1].exec_kind, "grep");
  const grepParams = both[1].params as { path?: string; pattern?: string; expect?: string };
  assert.equal(grepParams.path, "src/lib/foo.ts");
  assert.equal(grepParams.pattern, "guardBar");
  assert.equal(grepParams.expect, "present");
});

test("buildRepairSpecInput (legacy flat proposal): collapses to a single Phase 1 with a derived tsc check", () => {
  // The named failing state Phase 2 kills: the markdown path stamped every phase's Verification
  // prose as exec_kind='needs_human' and the chokepoint's assertEveryPhaseHasMachineCheck rejected
  // it — so every repair fix-spec parked at the CEO inbox. The structured path returns a phase
  // with a typed tsc check so the gate passes on the FIRST attempt.
  const input = buildRepairSpecInput(
    {
      slug: "fix-appstle-webhook",
      title: "Fix Appstle webhook 500",
      owner: "[[../functions/platform]]",
      intent: "Guard the webhook against the malformed payload class that's crashing it.",
      problem: "Appstle POSTs a subscription webhook whose `contract_id` is null; our handler NPEs on the deref.",
      proposedChange: "Add a null-guard around the `contract_id` deref in `handleAppstleSubscriptionWebhook`.",
      why: "The upstream schema does allow contract_id to be null (documented); a NPE here is our bug.",
      phase: "Guard the null case",
      target: "src/lib/inngest/appstle-webhooks.ts",
    },
    { signature: "vercel:appstle-webhook-npe", verdict: "real-bug", rootCause: "src/lib/inngest/appstle-webhooks.ts::real-bug" },
  );

  // Spec-level shape
  assert.equal(input.title, "Fix Appstle webhook 500");
  assert.equal(input.owner, "[[../functions/platform]]");
  assert.ok(input.why && input.why.trim().length > 0, "spec why is non-empty");
  assert.ok(input.what && input.what.trim().length > 0, "spec what is non-empty");
  assert.equal(input.parent, REPAIR_FIX_PARENT_PROSE, "parent falls back to the infra-devops-reliability mandate");

  // Single phase with a machine-runnable check
  assert.equal(input.phases.length, 1, "flat proposal collapses to a single phase");
  const phase1 = input.phases[0];
  assert.ok(phase1.body && phase1.body.trim().length > 0);
  assert.ok(phase1.verification && phase1.verification.trim().length > 0);
  assert.ok(phase1.why && phase1.why.trim().length > 0);
  assert.ok(phase1.what && phase1.what.trim().length > 0);
  assert.ok(phase1.checks && phase1.checks.length >= 1, "phase 1 carries >=1 typed check");
  assert.equal(phase1.checks![0].exec_kind, "tsc", "phase 1's first derived default is a tsc check");

  // Machine markers round-trip through the phase 1 body so parseRepairSpecMeta still finds them.
  const meta = parseRepairSpecMeta(phase1.body);
  assert.equal(meta.rootCause, "src/lib/inngest/appstle-webhooks.ts::real-bug", "**Repair-root-cause:** marker in body");
  assert.deepEqual(meta.signatures, ["vercel:appstle-webhook-npe"], "**Repair-signature:** marker in body");

  // Chokepoint gate: the structured phase's typed check(s) satisfy the ≥1-machine-runnable invariant.
  assert.doesNotThrow(() =>
    assertEveryPhaseHasMachineCheck(
      "fix-appstle-webhook",
      input.phases.map((p) => ({ title: p.title, checks: (p.checks as SpecPhaseCheckInput[]) ?? [] })),
    ),
  );
});

test("buildRepairSpecInput: uses Rafa's phases[] with typed grep on the target file when provided", () => {
  // When Rafa emits the NEW structured shape (phases[] with per-phase checks[]) the helper prefers
  // those over the derived defaults — the grep pattern (fix fingerprint) is Rafa's to choose because
  // only the LLM knows what the guard looks like. The helper never fabricates one.
  const input = buildRepairSpecInput(
    {
      slug: "fix-meta-ads-fatigue-null",
      title: "Fix Meta Ads fatigue-scan null deref",
      why: "The scan crashes when Meta returns no insights for the ad-set — a real defect in our reader.",
      what: "When this ships the fatigue scan gracefully handles empty insight arrays instead of NPE-ing.",
      target: "src/lib/meta/fatigue-scan.ts",
      phases: [
        {
          title: "Guard the empty-insights case",
          body: "In `src/lib/meta/fatigue-scan.ts`, guard the `insights[0].actions` deref against an empty array from Meta.",
          verification: "- `scanFatigueForAdSet` returns null (not throws) when `insights` is empty.",
          why: "Meta legitimately returns no insights when an ad set has zero delivery in the window.",
          what: "The scan tolerates an empty insights array without throwing.",
          checks: [
            { position: 1, description: "Repo typechecks clean after the guard lands.", kind: "auto", exec_kind: "tsc" },
            {
              position: 2,
              description: "`if (!insights.length)` is present in `src/lib/meta/fatigue-scan.ts`.",
              kind: "auto",
              exec_kind: "grep",
              params: { path: "src/lib/meta/fatigue-scan.ts", pattern: "if (!insights.length)", expect: "present" },
            },
          ],
        },
      ],
    },
    { signature: "vercel:meta-fatigue-npe", verdict: "real-bug", rootCause: "src/lib/meta/fatigue-scan.ts::real-bug" },
  );

  assert.equal(input.phases.length, 1);
  const phase = input.phases[0];
  assert.equal(phase.checks!.length, 2);
  assert.equal(phase.checks![0].exec_kind, "tsc");
  assert.equal(phase.checks![1].exec_kind, "grep");
  const grepParams = phase.checks![1].params as { path?: string; pattern?: string; expect?: string };
  assert.equal(grepParams.path, "src/lib/meta/fatigue-scan.ts");
  assert.equal(grepParams.pattern, "if (!insights.length)");
  assert.equal(grepParams.expect, "present");

  assert.doesNotThrow(() =>
    assertEveryPhaseHasMachineCheck(
      "fix-meta-ads-fatigue-null",
      input.phases.map((p) => ({ title: p.title, checks: (p.checks as SpecPhaseCheckInput[]) ?? [] })),
    ),
  );
});

test("buildRepairSpecInput: silently drops a typo'd exec_kind, then FALLS BACK to derived defaults so the phase stays machine-runnable", () => {
  // The one-retry-on-missing-machine-check path in runRepairJob covers the case where Rafa's
  // proposal has ONLY typo'd exec_kinds (e.g. 'ts' instead of 'tsc'). Here the helper drops the
  // typo'd row, and because Rafa's checks[] then reduces to empty, the derived defaults fill in —
  // the FIRST author attempt still lands with a valid tsc check. The retry path only fires when
  // the chokepoint's stricter validateExecutableCheck rejects the shape entirely.
  const input = buildRepairSpecInput(
    {
      slug: "fix-typoed-check",
      title: "Fix typo'd check",
      target: "src/lib/foo.ts",
      phases: [
        {
          title: "Land the fix",
          body: "Body.",
          verification: "- ok",
          why: "why",
          what: "what",
          checks: [
            // typo — 'ts' instead of 'tsc'. Dropped.
            { position: 1, description: "typechecks", kind: "auto", exec_kind: "ts" },
            // 'lint' isn't in the exec_kind vocabulary. Dropped.
            { position: 2, description: "lints", kind: "auto", exec_kind: "lint" },
          ],
        },
      ],
    },
    { signature: "sig", verdict: "real-bug", rootCause: "src/lib/foo.ts::real-bug" },
  );

  const phase = input.phases[0];
  assert.ok(phase.checks && phase.checks.length >= 1, "derived defaults filled the empty-after-drop slot");
  assert.equal(phase.checks![0].exec_kind, "tsc", "derived tsc default present");

  // Machine-check gate accepts the derived defaults.
  assert.doesNotThrow(() =>
    assertEveryPhaseHasMachineCheck(
      "fix-typoed-check",
      input.phases.map((p) => ({ title: p.title, checks: (p.checks as SpecPhaseCheckInput[]) ?? [] })),
    ),
  );
});

test("buildRepairSpecInput: strips a leading 'Phase 1 —' prefix off a Rafa-provided phase title", () => {
  // Serializer prepends its own `## Phase N — ` numbering; a Rafa title that already carries the
  // prefix would render "Phase 1 — Phase 1 — close it" without the strip.
  const input = buildRepairSpecInput(
    {
      slug: "fix-double-prefix",
      title: "Fix",
      target: "src/lib/foo.ts",
      phases: [{ title: "Phase 1 — land the guard", body: "b", verification: "- v", why: "w", what: "wh" }],
    },
    { signature: "s", verdict: "real-bug", rootCause: "src/lib/foo.ts::real-bug" },
  );
  assert.equal(input.phases[0].title, "land the guard");
});

test("REPAIR_FIX_PARENT_REF is the platform infra-devops-reliability mandate (same anchor as mario / coverage-register)", () => {
  // The mandate anchor keeps the chokepoint's `assertValidParent` from rejecting the parent as
  // bare-function free-text. Mirrors mario / coverage-register — one canonical anchor for every
  // autonomous platform-owned fix spec.
  assert.equal(REPAIR_FIX_PARENT_KIND, "mandate");
  assert.equal(REPAIR_FIX_PARENT_REF, "platform#infra-devops-reliability");
  assert.match(REPAIR_FIX_PARENT_PROSE, /\[\[\.\.\/functions\/platform\]\]/);
  assert.match(REPAIR_FIX_PARENT_PROSE, /Infra & DevOps \/ reliability/);
});

test("normalizeImplicatedFile + rootCauseKey remain stable — the structured helper reuses them for grep params", () => {
  // Regression pin: the derived grep check calls normalizeImplicatedFile(target) so a stray
  // "./src/lib/foo.ts:42" target still resolves to a repo-relative path.
  assert.equal(normalizeImplicatedFile("./src/lib/foo.ts:42"), "src/lib/foo.ts");
  assert.equal(normalizeImplicatedFile("`src/lib/foo.ts`"), "src/lib/foo.ts");
  assert.equal(rootCauseKey("src/lib/foo.ts", "real-bug"), "src/lib/foo.ts::real-bug");
});
