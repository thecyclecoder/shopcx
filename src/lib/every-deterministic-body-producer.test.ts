/**
 * Regression guard — every DETERMINISTIC spec-body producer authors ≥1 machine-runnable check
 * per phase. retire-md-spec-writers-db-is-sole-spec Phase 4 (Verification bullet 1).
 *
 * A deterministic producer = a pure function (no LLM inside) that builds a `StructuredSpecInput`
 * for one of the converted autonomous lanes. They are the sites the whole spec exists to fix —
 * before Phase 1/2/3 the same functions emitted markdown with a prose `## Verification` blob that
 * `parseVerificationBlobToChecks` stamped `exec_kind='needs_human'`, so the fix-spec parked at
 * the CEO inbox. After the conversion each returns a `StructuredSpecInput` whose every phase
 * carries a typed `exec_kind` machine check — this test locks that invariant in.
 *
 * COVERED PRODUCERS
 *   - coverage-register lane:  `buildRegisterSpecBody` (Phase 1)
 *   - coverage-register lane:  `buildExemptSpecBody`   (Phase 1)
 *   - repair (Rafa) lane:      `buildRepairSpecInput`  (Phase 2)
 *   - director-followup lane:  `buildStructuredSpecInputFromMarkdown` (Phase 3)
 *
 * A new deterministic producer added by a follow-up spec MUST be appended here — the test
 * asserts the invariant across the full producer set in one place.
 *
 * Run: npx tsx --test src/lib/every-deterministic-body-producer.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertEveryPhaseHasMachineCheck } from "./author-spec";
import { buildStructuredSpecInputFromMarkdown } from "./author-spec";
import { buildExemptSpecBody, buildRegisterSpecBody, inferLoopEntry } from "./coverage-register-agent";
import { buildRepairSpecInput } from "./repair-agent";
import type { StructuredSpecInput } from "./author-spec";
import type { SpecPhaseCheckInput } from "./spec-phase-checks-table";

/** Adapter — every producer returns a `StructuredSpecInput`. Return the object + a label the
 *  failure message can cite. */
function producers(): Array<{ label: string; input: StructuredSpecInput }> {
  const entry = inferLoopEntry("regression-guard-loop-cron", "0 8 * * *", "2026-07-13T00:00:00.000Z");
  return [
    { label: "buildRegisterSpecBody (coverage-register register)", input: buildRegisterSpecBody(entry) },
    { label: "buildExemptSpecBody (coverage-register exempt)", input: buildExemptSpecBody("regression-guard-loop-cron", "platform") },
    {
      label: "buildRepairSpecInput (repair lane — flat legacy proposal → derived tsc default)",
      input: buildRepairSpecInput(
        {
          slug: "regression-fix-target-a",
          title: "Regression fix target A",
          intent: "Guard the target against the failing shape.",
          problem: "The Control Tower signature persistently fires from this file.",
          proposedChange: "Add the missing guard in the implicated helper.",
          why: "The root cause traced above is not addressed by any existing spec.",
          target: "src/lib/regression-guard-target.ts",
          phase: "Land the guard",
        },
        { signature: "regression-guard-signature", verdict: "real-bug", rootCause: "src/lib/regression-guard-target.ts::real-bug" },
      ),
    },
    {
      label: "buildRepairSpecInput (repair lane — Rafa's structured phases[])",
      input: buildRepairSpecInput(
        {
          slug: "regression-fix-target-b",
          title: "Regression fix target B",
          why: "The upstream shape changed and our reader crashes.",
          what: "When this ships the reader tolerates the new shape.",
          target: "src/lib/regression-reader.ts",
          phases: [
            {
              title: "Guard the new shape",
              body: "In src/lib/regression-reader.ts, guard the deref against the new shape.",
              verification: "- The reader tolerates the new-shape input.",
              why: "Upstream schema is documented to allow this shape.",
              what: "The reader no longer throws on the new shape.",
              checks: [
                { position: 1, description: "Repo typechecks clean after the guard lands.", kind: "auto", exec_kind: "tsc" },
              ],
            },
          ],
        },
        { signature: "regression-reader-sig", verdict: "real-bug", rootCause: "src/lib/regression-reader.ts::real-bug" },
      ),
    },
    {
      label: "buildStructuredSpecInputFromMarkdown (director-followup lane)",
      input: buildStructuredSpecInputFromMarkdown(
        "regression-followup-fix",
        `# Followup spec ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[../functions/platform#infra-devops-reliability]]
**Why:** The parent lane surfaced a root cause the primary disposition can't fix.
**What:** When this ships the root cause is addressed by a durable code change.

## Phase 1 — land the fix ⏳

In \`src/lib/regression-followup.ts\`, add the missing guard.

### Verification
- The guard survives the next retrigger of the parent lane.
- Repo typechecks clean.
`,
      ),
    },
  ];
}

test("every deterministic spec-body producer emits ≥1 machine-runnable check per phase", () => {
  for (const p of producers()) {
    assert.ok(p.input.phases.length >= 1, `${p.label}: has at least one phase`);
    for (const phase of p.input.phases) {
      assert.ok(
        phase.checks && phase.checks.length >= 1,
        `${p.label}: phase "${phase.title}" carries at least one check`,
      );
      const hasMachineRunnable = (phase.checks as SpecPhaseCheckInput[]).some(
        (c) =>
          c.exec_kind === "tsc" ||
          c.exec_kind === "grep" ||
          c.exec_kind === "ci_status" ||
          c.exec_kind === "http_get" ||
          c.exec_kind === "db_probe_readonly" ||
          c.exec_kind === "unit_test" ||
          c.exec_kind === "build",
      );
      assert.ok(hasMachineRunnable, `${p.label}: phase "${phase.title}" has a machine-runnable check`);
    }
  }
});

test("every deterministic producer's StructuredSpecInput passes assertEveryPhaseHasMachineCheck (the chokepoint gate)", () => {
  // Direct chokepoint invocation — the exact rail every autonomous author path now funnels through.
  // A producer that regresses fails LOUD here, mirroring the retirement of the markdown chokepoint.
  for (const p of producers()) {
    assert.doesNotThrow(
      () =>
        assertEveryPhaseHasMachineCheck(
          `regression-${p.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
          p.input.phases.map((phase) => ({
            title: phase.title,
            checks: (phase.checks as SpecPhaseCheckInput[]) ?? [],
          })),
        ),
      `${p.label}: assertEveryPhaseHasMachineCheck must accept the producer's output`,
    );
  }
});
