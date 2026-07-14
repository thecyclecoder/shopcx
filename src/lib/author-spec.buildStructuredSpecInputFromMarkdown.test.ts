/**
 * author-spec: `buildStructuredSpecInputFromMarkdown` tests — retire-md-spec-writers-db-is-sole-spec
 * Phase 3 (director-followup lane coercion).
 *
 * Durable contract: the helper takes an already-validated followup markdown body (the caller's own
 * pre-write shape gate — for platform-director that's `validateFollowupSpec`) and returns a typed
 * `StructuredSpecInput` where every phase carries at least one `exec_kind`-declared machine check.
 * A default `exec_kind:'tsc'` check per phase means the every-writer-authors-machine-runnable-
 * verifications chokepoint gate (`assertEveryPhaseHasMachineCheck`) accepts the input on the FIRST
 * attempt — no follow-up spec parks at the CEO inbox because the LLM wrote prose Verification
 * bullets.
 *
 * Run: npx tsx --test src/lib/author-spec.buildStructuredSpecInputFromMarkdown.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertEveryPhaseHasMachineCheck, buildStructuredSpecInputFromMarkdown } from "./author-spec";
import type { SpecPhaseCheckInput } from "./spec-phase-checks-table";

const SAMPLE_FOLLOWUP = `# Fix the broken tag parser ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[../functions/platform#infra-devops-reliability]]
**Why:** The tag parser fails on unicode input, blocking the ingest pipeline.
**What:** When this ships, the tag parser accepts unicode input without throwing.

## Phase 1 — land the unicode-safe guard ⏳

In \`src/lib/tag-parser.ts\`, guard the \`normalizeTag\` deref against a null-latin-1 codepoint mapping.

### Verification
- \`normalizeTag\` returns the input unchanged when given a unicode tag.
- Repo typechecks clean.
`;

test("returns StructuredSpecInput with title / owner / parent / why / what parsed from the markdown", () => {
  const input = buildStructuredSpecInputFromMarkdown("fix-broken-tag-parser", SAMPLE_FOLLOWUP);
  assert.equal(input.title, "Fix the broken tag parser");
  assert.equal(input.owner, "platform");
  assert.ok(input.parent && input.parent.includes("platform#infra-devops-reliability"));
  assert.ok(input.why && input.why.includes("tag parser fails on unicode"));
  assert.ok(input.what && input.what.includes("tag parser accepts unicode"));
  assert.equal(input.phases.length, 1);
});

test("every phase carries at least one machine-runnable `exec_kind:'tsc'` check", () => {
  // The retire-md-spec-writers-db-is-sole-spec Phase 3 invariant: the coerced input passes
  // `assertEveryPhaseHasMachineCheck` on the first attempt so a prose-only follow-up markdown never
  // parks at the CEO. The default tsc check is the safe cross-lane primitive (every fix-spec gates on
  // tsc-clean before merge anyway; this makes the deterministic runner able to observe it).
  const input = buildStructuredSpecInputFromMarkdown("fix-broken-tag-parser", SAMPLE_FOLLOWUP);
  for (const p of input.phases) {
    assert.ok(p.checks && p.checks.length >= 1, `phase ${p.title}: at least one check`);
    assert.ok(
      (p.checks as SpecPhaseCheckInput[]).some((c) => c.exec_kind === "tsc"),
      `phase ${p.title}: has a tsc machine check`,
    );
  }
  assert.doesNotThrow(() =>
    assertEveryPhaseHasMachineCheck(
      "fix-broken-tag-parser",
      input.phases.map((p) => ({ title: p.title, checks: (p.checks as SpecPhaseCheckInput[]) ?? [] })),
    ),
  );
});

test("the phase's `verification` column preserves the LLM's prose bullets verbatim (founder-facing)", () => {
  const input = buildStructuredSpecInputFromMarkdown("fix-broken-tag-parser", SAMPLE_FOLLOWUP);
  const phase = input.phases[0];
  assert.ok(phase.verification.includes("normalizeTag"), "prose bullet 1 preserved");
  assert.ok(phase.verification.includes("Repo typechecks clean"), "prose bullet 2 preserved");
});

test("falls back to synthesized intent when the markdown lacks **Why:** / **What:** headers", () => {
  // A markdown followup body missing the intent headers still lands (the previous markdown path
  // soft-warned; the structured chokepoint hard-gates so the coercion synthesizes non-empty
  // placeholders drawn from the spec title / summary rather than throwing MissingIntentError).
  const minimal = `# Restore the missing cron heartbeat ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[../functions/platform#infra-devops-reliability]]

## Phase 1 — land the missing emitCronHeartbeat call ⏳

In \`src/lib/inngest/some-cron.ts\`, add the trailing \`emitCronHeartbeat\` call.

### Verification
- The \`some-cron\` tile stays green after one tick.
`;
  const input = buildStructuredSpecInputFromMarkdown("restore-cron-heartbeat", minimal);
  assert.ok(input.why && input.why.trim().length > 0, "synthesized why");
  assert.ok(input.what && input.what.trim().length > 0, "synthesized what");
});
