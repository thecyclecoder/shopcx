/**
 * Author the build-infra hardening spec that came out of the 2026-07-05
 * commerce-sdk-display-operations wedge: the box's primary checkout got parked on
 * a build branch, so every `git worktree add` for that branch failed and the build
 * could not proceed until a human freed it. Standalone Platform fix (no milestone),
 * parented under the Autonomous-build-platform mandate. Authored via the chokepoint
 * (lands in_review for Vale; owner approves out of review to build).
 *
 * Run: npx tsx scripts/_author-wedge-fix-spec.ts        (dry)
 *      APPLY=1 npx tsx scripts/_author-wedge-fix-spec.ts (writes)
 */
import "./_bootstrap";
import { getSpec } from "../src/lib/specs-table";
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "box-primary-checkout-branch-wedge-self-heal";
const APPLY = process.env.APPLY === "1";

const PARENT =
  "Platform function → 'Autonomous build platform' mandate ([[../functions/platform]]) — keep the " +
  "idea→spec→build loop safe, legible, and capable.";

async function main() {
  if (await getSpec(WS, SLUG)) { console.log(`${SLUG} already exists — skip.`); return; }
  console.log(`Author ${SLUG} (owner=platform, standalone fix, parent=platform#build)`);
  if (!APPLY) { console.log("DRY RUN — set APPLY=1 to write."); return; }

  const ok = await authorSpecRowStructured(
    WS, SLUG,
    {
      title: "Box builds: self-heal a primary checkout wedged on a build branch",
      summary:
        "Root-cause hardening for the 2026-07-05 commerce-sdk-display-operations build wedge. The box's PRIMARY " +
        "checkout (/home/builder/shopcx) got parked on `claude/build-commerce-sdk-display-operations` with " +
        "uncommitted brain-page output, so every build's `git worktree add -B <branch>` failed with \"already used " +
        "by worktree at /home/builder/shopcx\". The existing guard (scripts/builder-worker.ts:2384) CORRECTLY refuses " +
        "to `rm -rf` the primary repo to free it — but that converts the failure into a SILENT WEDGE that blocks " +
        "every build of that branch until a human resets the primary by hand (as was done to recover this incident). " +
        "This is a recurring class: the worker already carries the guard + a prior-incident comment. Make a wedged " +
        "primary auto-recover, and stop any step from leaving the primary on a feature branch.",
      owner: "platform",
      parent: PARENT,
      blocked_by: [],
      why:
        "A single stuck primary checkout hard-blocks EVERY build of the affected branch with no self-recovery — a " +
        "human had to SSH in and reset the box to unstick commerce-sdk-display-operations. The build pipeline must " +
        "heal this itself; the primary checkout being on a feature branch (with loose output) should never be able to " +
        "permanently wedge a build.",
      what:
        "A build can never be permanently blocked by the primary checkout being parked on its branch: the worker " +
        "resets the primary to origin/main before it matters, the reaper frees a primary-held branch by switching " +
        "(never nuking) the primary, and no agent/build step leaves the primary on a feature branch.",
      phases: [
        {
          title: "Phase 1 — Reset the primary to main as a build-claim precondition",
          body:
            "Before a build claims + creates its per-slug worktree, assert the primary checkout (REPO_DIR) is on main " +
            "and clean; if it is on a feature branch OR dirty, recover it first: stash/clean any loose files, `git " +
            "switch main`, `git reset --hard origin/main`, delete the stale local build branch. Runs as the worker's " +
            "own user (correct git ownership). This makes a wedged primary AUTO-RECOVER instead of failing the " +
            "worktree-add. Composes with the existing periodic self-update (`git reset --hard origin/main`) — this " +
            "makes it a precondition, not only a periodic.",
          verification:
            "- On the box with the primary checkout manually put on a feature branch (git switch -c wedge-test), expect " +
            "the next build claim to reset REPO_DIR to main before `git worktree add`, and the build to proceed (no " +
            "\"already used by worktree\" failure).\n" +
            "- On grep of scripts/builder-worker.ts, expect a claim-time precondition that verifies REPO_DIR HEAD == main " +
            "(or heals it) before worktree setup.",
          why:
            "The wedge that blocked this incident was exactly a primary parked on the build branch — resetting it at " +
            "claim time removes the block before a worktree-add can ever collide.",
          what: "A build claim that finds the primary off-main heals it to origin/main before creating its worktree.",
        },
        {
          title: "Phase 2 — Reaper frees a primary-held branch by switching, never nuking",
          body:
            "When `git worktree add -B <branch>` fails because the branch is held by the PRIMARY checkout (path == " +
            "REPO_DIR, not a build worktree under builds/), the reaper/worktree-add precondition recovers by switching " +
            "the primary to main (freeing the branch) and retrying — instead of failing the build terminally. The " +
            "existing SAFETY guard that refuses to `rm -rf` the primary (builder-worker.ts:2384-2391) stays intact; " +
            "this adds a switch-based recovery for the one path that guard currently dead-ends.",
          verification:
            "- On a simulated primary-held branch, expect the worktree-add precondition to FREE it by switching the " +
            "primary to main (NOT `rm -rf`) and the retried `git worktree add -B` to succeed.\n" +
            "- On grep of the removeWorktreeForBranch / worktree-add path, expect the primary-repo `rm -rf` guard " +
            "(builder-worker.ts:2384) to remain and a switch-to-main recovery to be added for the REPO_DIR case.",
          why:
            "Today the guard correctly protects the primary but leaves the build dead-ended; freeing the branch by a " +
            "safe `git switch` recovers without the destructive path the guard blocks.",
          what: "A build worktree-add that collides with the primary recovers automatically instead of failing.",
        },
        {
          title: "Phase 3 — No step leaves the primary on a feature branch",
          body:
            "Audit the worker paths that operate on REPO_DIR and ensure any branch checkout / PR diff / brain-page " +
            "generation runs in an ISOLATED worktree (the existing investWt pattern at builder-worker.ts:5865-5890), " +
            "never in the primary. Add a lightweight assertion (startup + periodic reaper tick) that logs + heals if " +
            "REPO_DIR is ever found off-main, so a regression surfaces immediately rather than as a silent wedge.",
          verification:
            "- On grep for `checkout`/`switch` git invocations with cwd REPO_DIR in scripts/builder-worker.ts, expect " +
            "none that can leave the primary on a feature branch (all branch work uses a worktree).\n" +
            "- On the periodic reaper tick with REPO_DIR forced off-main, expect a logged heal back to origin/main.",
          why:
            "The loose commerce__*.md brain pages in the primary show a step DID run branch work in the primary; " +
            "closing that keeps the wedge from re-forming and makes any regression loud.",
          what: "Every branch operation runs in a worktree, and an off-main primary self-heals and is logged.",
        },
      ],
    },
    "planned",
    { parentKind: "mandate", parentRef: "platform#build", intendedStatusSetBy: "founder-incident-followup" },
  );
  console.log(ok ? `✓ authored ${SLUG} (in_review)` : "✗ authorSpecRowStructured returned false — gate failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
