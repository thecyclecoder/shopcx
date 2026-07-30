import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "pre-merge-fix-skip-external-test-regressions-not-in-spec-diff",
    {
      title: "Pre-merge fix: a unit_test failure in a test file the spec's branch didn't touch is an external regression — don't append a Fix phase that strands the spec",
      why: "A spec's pre-merge spec-test can go RED on a unit_test check whose failing test lives in a file the spec never modified. When that happens, pre-merge-fix appends a kind='fix' phase to the origin spec and re-opens it — but the spec cannot fix a regression in someone else's code, so it churns Fix 1, Fix 2, escalates, and a shipped/correct spec sits stranded in the pipeline. This just happened: the media-buyer digest spec (all code shipped) declared a unit_test check running test:media-buyer-agent — a test in agent.test.ts, which the digest spec doesn't own — and an unrelated change (#29's ready-to-test .neq) transiently broke that test, stranding the shipped digest spec and spawning a whole redundant fix-spec. There is already precedent for filtering non-spec failures: pre-merge-fix filters HARNESS/COMMAND-signature failures via isHarnessCommandFailure (the vera-harness-error-is-not-a-code-regression spec). An external-test regression should be filtered the same way.",
      what: "Classify a pre-merge unit_test failure whose failing test file is NOT in the build branch's diff as an external regression, filter it out of the fix-phase append set (like harness failures), and surface it as a standalone regression owned by whoever last touched that test — never append it as a Fix phase on the innocent spec.",
      summary: "Extend the pre-merge fix path (src/lib/pre-merge-fix.ts, which already filters isHarnessCommandFailure from @/lib/spec-test-harness-classifier) with an isExternalTestRegression check: a unit_test failing check whose test file (resolved from the package.json script) is outside `git diff --name-only main...{branch}` is dropped from the appendFixPhases set and recorded as a separate regression, not a Fix phase on the origin spec.",
      owner: "platform",
      parent: '[[../functions/platform]] — "Autonomous build platform" mandate: the fixes-as-phases loop strands a correct spec when it appends a Fix phase for a regression the spec did not cause; the classifier that already excludes harness failures must also exclude external-test regressions. See [[../libraries/pre-merge-fix]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Classify + filter external-test regressions out of the fix-append set",
          why: "pre-merge-fix appends a Fix phase for any red check except harness failures; a unit_test failure outside the spec's diff is not this spec's regression and must not re-open it.",
          what: "Add an external-test-regression classifier and apply it alongside the existing harness filter in the fix-phase append path.",
          body: "In src/lib/pre-merge-fix.ts, where the failing checks are filtered before appendFixPhases (the existing isHarnessCommandFailure filter, ~import line 27): add `isExternalTestRegression(check, touchedFiles)` — for a unit_test check, resolve the test file(s) the check's package.json `script` runs (parse the script command, e.g. `tsx --test src/lib/media-buyer/agent.test.ts`), and return true when NONE of those files are in `touchedFiles` (the build branch's diff vs main: `git diff --name-only main...{branch}`, already available or cheaply computed from the branch this function receives). Drop external-regression checks from the set that appends Fix phases, exactly like harness failures. For each dropped external regression, record a director_activity `escalated`/regression row naming the failing test + the last committer to it (git log -1 on the test file) so the regression is owned by its breaker, not the innocent spec. Put the classifier in src/lib/spec-test-harness-classifier.ts (beside isHarnessCommandFailure) or a sibling module, with a unit test covering: (a) unit_test failure whose test file IS in the diff → NOT external (real, append Fix); (b) test file NOT in the diff → external (skip). Update docs/brain/libraries/pre-merge-fix.md per CLAUDE.md.",
          verification: "- tsc clean\n- the external-test-regression classifier exists and is wired into pre-merge-fix\n- its unit test passes",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the external-test-regression classifier exists", kind: "auto", exec_kind: "grep", params: { pattern: "isExternalTestRegression", path: "src/lib/spec-test-harness-classifier.ts", expect: "present" } },
            { position: 3, description: "pre-merge-fix imports/uses the classifier", kind: "auto", exec_kind: "grep", params: { pattern: "isExternalTestRegression", path: "src/lib/pre-merge-fix.ts", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#build" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
