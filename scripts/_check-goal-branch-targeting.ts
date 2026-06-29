/**
 * Static-analysis check: the box worker's BUILD path never lets a GOAL-BOUND spec base on — or open a PR to —
 * `main`. This guards the spec-goal-branch-pm-flow M4/M5 invariant that regressed live (noop-goal-test-a/-b →
 * PRs #859/#860 BOTH baseRefName=main, the goal branch `goal/noop-goal-test` never created): two parallel
 * first-builds of a goal each read "goal branch absent → I'm first → base on main" and each opened its own PR
 * to main, so the atomic goal→main promotion (Gate C) was unreachable.
 *
 * The fix makes a goal-bound spec ALWAYS create-or-observe its goal branch race-safely and base/PR onto THAT.
 * This check asserts the regression can't silently return:
 *
 *   1. The race-safe goal-branch CREATE exists — a `git push origin origin/main:refs/heads/goal/...` in the
 *      build path (create-from-main; the concurrent-create winner is treated as success on re-probe).
 *   2. The build path no longer contains the old "first spec of the goal; basing on main" capitulation string.
 *   3. The `ensurePr` signature takes a `base` parameter (so a goal-bound PR can target the goal branch).
 *   4. The accumulation-complete PR open resolves a goal slug and targets `goal/${...}` (not a hardcoded main).
 *
 * Read-only by construction: reads the source, exits non-zero on a mismatch. Never mutates state. Wired into
 * `predeploy` so a regression fails CI red, not silently.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const WORKER_PATH = resolve(__dirname, "builder-worker.ts");

function fail(msg: string): never {
  console.error(`\n❌ check-goal-branch-targeting — ${msg}\n`);
  process.exit(1);
}

function readWorker(): string {
  try {
    return readFileSync(WORKER_PATH, "utf8");
  } catch (e) {
    fail(`could not read ${WORKER_PATH}: ${(e as Error).message}`);
  }
}

function main() {
  const src = readWorker();
  const problems: string[] = [];

  // 1. Race-safe goal-branch create: a push of main → refs/heads/goal/{slug}. Tolerant of the interpolation.
  const raceCreate = /push",\s*\[?[^\]]*origin\/main:refs\/heads\/\$\{goalBranch\}/.test(src)
    || /push",\s*"origin",\s*`origin\/main:refs\/heads\/\$\{goalBranch\}`/.test(src)
    || /origin\/main:refs\/heads\/\$\{goalBranch\}/.test(src);
  if (!raceCreate) {
    problems.push(
      "the race-safe goal-branch CREATE is missing — expected a `git push origin origin/main:refs/heads/${goalBranch}` in the build path (create-from-main, exactly-once under concurrency).",
    );
  }

  // 2. The old capitulation must be gone — a goal-bound spec must NEVER fall back to basing on main.
  if (/goal branch doesn't exist yet — first spec of the goal; basing on main/.test(src)) {
    problems.push(
      "the build path still contains the old \"first spec of the goal; basing on main\" fallback — a goal-bound spec must base on the goal branch, never main (this is the exact regressed race).",
    );
  }

  // 3. ensurePr must accept a `base` parameter (so a goal-bound PR targets the goal branch).
  if (!/async function ensurePr\([^)]*\bbase\b/.test(src)) {
    problems.push(
      "ensurePr no longer accepts a `base` parameter — a goal-bound spec's PR could only target a hardcoded main.",
    );
  }

  // 4. The accumulation-complete PR open must resolve a goal slug and target `goal/${...}`.
  const targetsGoalBranch = /prBase\s*=\s*`goal\/\$\{prGoalSlug\}`/.test(src) || /base.*`goal\/\$\{/.test(src);
  if (!targetsGoalBranch) {
    problems.push(
      "the accumulation-complete PR open does not target `goal/${goalSlug}` for goal-bound specs — a goal-bound PR would target main (Gate A would not merge it, but the PR artifact would be wrong and the goal branch would never accumulate it).",
    );
  }

  if (problems.length) {
    fail(`goal-branch targeting invariant violated:\n  - ${problems.join("\n  - ")}`);
  }

  console.log(
    "✓ check-goal-branch-targeting — goal-bound specs create their goal branch race-safely and base/PR onto it (never main); one-off specs still target main.",
  );
}

main();
