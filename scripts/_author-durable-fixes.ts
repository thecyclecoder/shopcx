import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RELIABILITY = {
  intendedStatusSetBy: "ceo" as const,
  parentKind: "mandate" as const,
  parentRef: "platform#infra-devops-reliability",
  autoBuild: true,
};

async function main() {
  // ── Durable fix 1: goal-member build serialization must gate at ENQUEUE, not at claim ──
  const ok1 = await authorSpecRowStructured(
    WS,
    "goal-member-builds-gate-at-enqueue-not-at-claim",
    {
      title: "Goal-member build serialization must gate at the queue, not at claim time",
      why:
        "Two members of the same goal deadlocked the pipeline today. The serializer that keeps one " +
        "goal-member build running at a time enforces this at CLAIM time: both member builds were already " +
        "in the queue, both got claimed within 200 milliseconds, each then saw the other as in-flight and " +
        "backed itself out, and neither built. They re-raced on every cooldown cycle, so the goal stalled " +
        "with idle build lanes until a human broke the tie by hand. Serializing after admission is the " +
        "root cause — the queue let a second member in when it never should have.",
      what:
        "The queue admits at most one build per goal at a time. A later goal-member build is not enqueued " +
        "while a sibling's build is active or already queued; it is admitted only when the active sibling " +
        "completes. With only one member build ever in the queue per goal, the same-tick claim race and " +
        "the mutual-standoff deadlock become impossible.",
      summary:
        "Move intra-goal build serialization from a claim-time hold to an enqueue-time admission gate. " +
        "Current claim-time serializer: src/lib/agent-jobs.ts:1448 (the 'another goal-member build is " +
        "in-flight' check) consumed by scripts/builder-worker.ts:5489 (claim-gate requeue disposition). " +
        "Build-enqueue chokepoints to gate: src/lib/agent-jobs.ts:636 + :2402 (auto-queue / " +
        "buildOnEligible) and src/lib/roadmap-actions.ts queueRoadmapBuild. Release-on-completion should " +
        "mirror the existing chained-phase release (reconcileMergedJobs → queueNextChainedPhase).",
      owner: "platform",
      parent:
        '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: a goal that deadlocks its ' +
        "own member builds is a silent pipeline-reliability failure the build platform must prevent.",
      critical: true,
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Enqueue-time admission gate: one goal-member build in the queue at a time",
          why:
            "If two goal-member builds can both sit in the queue, they can both be claimed in the same " +
            "tick and mutually starve. Preventing a second member from entering the queue removes the race " +
            "at its source.",
          what:
            "At every build-enqueue chokepoint, a build for a goal-member spec is admitted only when no " +
            "sibling in the same goal already has a queued or active build; otherwise it is left eligible " +
            "but un-queued, to be admitted later.",
          body:
            "In the build-enqueue paths (src/lib/agent-jobs.ts:636 and :2402 auto-queue / buildOnEligible, " +
            "and src/lib/roadmap-actions.ts queueRoadmapBuild), before inserting a build agent_jobs row for " +
            "a spec whose goal has sibling members, check for any sibling goal-member with a build in " +
            "status queued/claimed/building; if one exists, do NOT insert — return a 'serialized, not " +
            "admitted' result and leave the spec eligible-but-unqueued. Reuse areSpecsGoalMates / the goal " +
            "membership lookup already in agent-jobs.ts. Update the build-lifecycle brain page.",
          verification:
            "Attempt to enqueue builds for two members of the same goal back to back: assert exactly ONE " +
            "build agent_jobs row exists for that goal afterward, and the second enqueue returns the " +
            "'serialized, not admitted' result (no row inserted).",
          status: "planned",
        },
        {
          title: "Phase 2 — Release the next member on completion; retire the claim-time serializer",
          why:
            "Once admission is gated, the next goal-member must be admitted when the active one finishes, " +
            "or the goal stalls; and the old claim-time serializer becomes dead weight that can still race.",
          what:
            "When a goal-member build completes (ships or terminally fails), the next eligible sibling is " +
            "admitted to the queue. The claim-time serializer is removed or downgraded to an assertion " +
            "that must never fire under the enqueue gate.",
          body:
            "Extend the merge/completion reconciler (reconcileMergedJobs, the same place " +
            "queueNextChainedPhase runs) to admit the next eligible goal-member build when the active one " +
            "completes. Remove the claim-time hold at scripts/builder-worker.ts:5489 / the in-flight check " +
            "at src/lib/agent-jobs.ts:1448, or keep it only as a defensive assertion (log-and-escalate if " +
            "it ever triggers, since the enqueue gate should make it unreachable). Update the brain page.",
          verification:
            "Enqueue two goal-members; let the admitted one ship; assert the second is auto-admitted to " +
            "the queue exactly once afterward and builds, and that the claim-time serializer path is never " +
            "hit (no 'held until the goal serializer releases' log during the run).",
          status: "planned",
        },
      ],
    },
    "planned",
    RELIABILITY,
  );
  console.log(ok1 ? "authored: goal-member-builds-gate-at-enqueue-not-at-claim (critical)" : "FAILED spec 1");

  // ── Durable fix 2: a Vale PASS must always durably stamp the review-passed flag ──
  const ok2 = await authorSpecRowStructured(
    WS,
    "spec-review-pass-always-stamps-review-passed-flag",
    {
      title: "Spec-review pass must always stamp the durable review-passed flag",
      why:
        "A spec that passes Vale review can silently never build. The build claim-gate only launches a " +
        "build when the spec carries a durable review-passed stamp, but some pass paths mark the review " +
        "as passed without setting that stamp. Observed today on the mario-pipeline-plumbing goal: three " +
        "member specs passed review yet their builds were re-queued every 90 seconds with idle build " +
        "lanes, until a human hand-stamped the flag. It will recur for any spec that passes through the " +
        "same path.",
      what:
        "Every Vale pass durably records the review-passed stamp so a passed spec is always claimable, and " +
        "a reconciler self-heals any spec that passed review but is missing the stamp instead of leaving " +
        "it stuck.",
      summary:
        "Guarantee specs.vale_review_passed_at is set on every spec-review PASS and add a reconciler for " +
        "passed-but-unstamped specs. Grounded in scripts/builder-worker.ts:5560 (claimHeldForUnreviewedSpec) " +
        "+ :50 (BUILD_GATE_HOLD_COOLDOWN_MS), src/lib/brain-roadmap.ts:744 (valeReviewPassed derives from " +
        "vale_review_passed_at), src/lib/spec-card-state.ts:609 (markSpecCardValePassed), and the " +
        "author-intent fallback at src/lib/agents/spec-dispose.ts:141-148.",
      owner: "platform",
      parent:
        '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: a passed spec that never ' +
        "builds is a silent pipeline-reliability failure the build platform must not allow.",
      critical: true,
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Stamp the durable review-passed flag on every pass",
          why:
            "The build claim-gate cannot launch a spec that lacks the durable review-passed stamp, so any " +
            "pass path that omits it is a silent build stall. Some goal members were stamped and built " +
            "while others passed review yet stayed unstamped — that divergence must be closed at the source.",
          what:
            "A Vale pass always records the durable review-passed stamp before Ada's disposition runs, " +
            "including the author-intent fallback branch, and the stamp survives the disposition.",
          body:
            "Root-cause why some specs recorded a spec_review_passed director_activity row yet " +
            "vale_review_passed_at stayed NULL. Fix the source so every pass durably stamps the flag via " +
            "markSpecCardValePassed (src/lib/spec-card-state.ts:609), including the author-intent fallback " +
            "in src/lib/agents/spec-dispose.ts:141-148. Confirm vale_review_passed_at is NOT consumed by " +
            "Ada's disposition (unlike vale_pass). Update the agents-spec-review / spec-dispose brain page.",
          verification:
            "Drive a fresh spec through spec-review to a PASS: assert specs.vale_review_passed_at is " +
            "non-NULL right after the pass AND after disposition, and its build is claimed (status " +
            "queued → building) within one poll rather than re-queued with a future claimed_at.",
          status: "planned",
        },
        {
          title: "Phase 2 — Reconciler: passed-but-unstamped self-heals",
          why:
            "A stray unstamped-but-passed spec must not loop forever; it should be repaired automatically " +
            "rather than needing a human to hand-stamp it.",
          what:
            "A reconciler detects a spec that has a spec_review_passed record but a missing review-passed " +
            "stamp and stamps it, logging the heal for audit; a genuinely-unreviewed spec is untouched.",
          body:
            "Add a periodic (or claim-adjacent) reconciler that finds specs with a spec_review_passed " +
            "director_activity row and NULL vale_review_passed_at and stamps them via markSpecCardValePassed, " +
            "recording a director_activity heal row. Do not touch specs with no spec_review_passed record. " +
            "Update the brain page.",
          verification:
            "Seed a spec with a spec_review_passed row and NULL vale_review_passed_at: assert the reconciler " +
            "stamps it (and its build proceeds), while a spec with no such row is left unstamped.",
          status: "planned",
        },
      ],
    },
    "planned",
    RELIABILITY,
  );
  console.log(ok2 ? "authored: spec-review-pass-always-stamps-review-passed-flag (critical)" : "FAILED spec 2");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
