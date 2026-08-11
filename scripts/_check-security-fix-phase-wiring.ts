/**
 * Static-analysis check: a PRE-MERGE `real-vuln` security finding must route to FIXES-AS-PHASES,
 * never to a standalone fix spec.
 *
 * THE INCIDENT THIS GUARD EXISTS FOR (2026-08-11). On 2026-07-03, `a2936e0c8` wired pre-merge security
 * findings into the fixes-as-phases path: a `real-vuln` on an in-flight `claude/build-*` branch appends a
 * `kind='fix'` PHASE to the ORIGIN spec (`spawnPreMergeFix`) and resumes its build on the SAME branch.
 * On 2026-07-17, `610790798` ("graduate-vera follow-ups: remove dead Vera code") deleted that block's ONLY
 * caller along with the genuinely-dead fused-session code — leaving `buildSecurityFailingChecks` defined
 * but never called, and silently falling every pre-merge security finding back to the RETIRED standalone
 * fix-spec model.
 *
 * That is unrecoverable, not merely wrong: a standalone fix spec lands on its OWN branch, so the ORIGIN's
 * branch never advances, so `enqueueSecurityReviewBranch`'s unchanged-branch dedup never re-reviews it, so
 * the `real-vuln` verdict is PERMANENT and the origin PR can never promote. Observed live: PRs #2427 and
 * #2438 sat 17–24h, accumulation-complete AND spec-test green, unpromotable, with no card and no error.
 * Pre-merge `kind='fix'` phase creation fell to ZERO from 2026-07-20 onward.
 *
 * ADMISSION CRITERION ([[../docs/brain/operational-rules]] § Predeploy static guards): a violation here
 * produces NO error anyone would see — no throw, no red build, no failing test; just an orphaned function
 * and a pipeline that quietly stops self-healing. That is precisely the silent class this chain is for.
 *
 * WHAT IT ASSERTS (all in `scripts/builder-worker.ts`):
 *   1. `buildSecurityFailingChecks` is CALLED, not merely defined — the envelope→`sec:`-keyed-checks mapper
 *      is the entry to the fixes-as-phases path; an orphaned definition IS the regression signature.
 *   2. `spawnPreMergeFix` is imported/called — the fix-PHASE authoring path is actually reachable.
 *   3. The branch-mode real-vuln short-circuit still guards on `source.kind === "branch"` — so the
 *      post-merge (`diff`) path keeps authoring a follow-up spec (correct: no live branch to append to).
 *
 * Read-only, no I/O beyond `readFileSync`. Exits 1 with a remediation on violation.
 *
 *   Run:    npx tsx scripts/_check-security-fix-phase-wiring.ts
 *   Wired:  `npm run check:security-fix-phase-wiring` → chained into `predeploy:static`.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const SRC = resolve(__dirname, "builder-worker.ts");

interface Assertion {
  name: string;
  test: (src: string) => boolean;
  why: string;
}

const ASSERTIONS: Assertion[] = [
  {
    name: "buildSecurityFailingChecks is CALLED, not just defined",
    // A definition is `function buildSecurityFailingChecks(`; a call is any other `buildSecurityFailingChecks(`.
    test: (src) => {
      const calls = [...src.matchAll(/(?<!function\s)\bbuildSecurityFailingChecks\s*\(/g)];
      return calls.length > 0;
    },
    why:
      "`buildSecurityFailingChecks` maps a security envelope's findings → `sec:`-keyed failing checks — the ENTRY to the fixes-as-phases path. " +
      "An orphaned definition is the exact 2026-07-17 regression signature: every pre-merge real-vuln silently falls back to a standalone fix spec, " +
      "which can never clear the origin branch (permanent deadlock).",
  },
  {
    name: "spawnPreMergeFix is reachable from the security path",
    test: (src) => /spawnPreMergeFix/.test(src),
    why:
      "The fix must be appended as a `kind='fix'` PHASE on the ORIGIN spec (src/lib/pre-merge-fix.ts) so it builds on the origin's OWN branch. " +
      "That push is what earns the fresh security re-review that clears the verdict. Without it the loop cannot close.",
  },
  {
    name: "the real-vuln short-circuit is scoped to branch mode",
    test: (src) => /verdict === "real-vuln"\s*&&\s*source\.kind === "branch"/.test(src),
    why:
      "Only PRE-MERGE (`branch`) findings become fix phases. POST-MERGE (`diff`) findings must still author a follow-up spec — the origin already " +
      "shipped, so there is no live branch build to append a phase to. Dropping the `source.kind === \"branch\"` guard breaks the post-merge lane.",
  },
];

function main() {
  let src: string;
  try {
    src = readFileSync(SRC, "utf8");
  } catch (e) {
    console.error(`❌ check-security-fix-phase-wiring — could not read ${SRC}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  const failures = ASSERTIONS.filter((a) => !a.test(src));
  if (failures.length === 0) {
    console.log(`✅ check-security-fix-phase-wiring — pre-merge real-vuln routes to fixes-as-phases (${ASSERTIONS.length} assertions)`);
    return;
  }

  console.error(`❌ check-security-fix-phase-wiring — ${failures.length} broken assertion(s) in scripts/builder-worker.ts:\n`);
  for (const f of failures) {
    console.error(`  • ${f.name}`);
    console.error(`      ${f.why}\n`);
  }
  console.error(
    "WE DO NOT DO FIX SPECS for a live branch. A pre-merge `real-vuln` appends a `kind='fix'` PHASE to the ORIGIN spec\n" +
      "(spawnPreMergeFix) and resumes its build on the SAME `claude/build-*` branch. That new push is what earns the fresh\n" +
      "security review that clears the verdict — a standalone fix spec lands elsewhere and the origin can NEVER go green.\n" +
      "See docs/brain/lifecycles/spec-build-pipeline.md row 6b and src/lib/pre-merge-fix.ts's module header.",
  );
  process.exit(1);
}

main();
