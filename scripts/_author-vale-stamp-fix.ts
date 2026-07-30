import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WS,
    "spec-review-pass-always-stamps-review-passed-flag",
    {
      title: "Spec-review pass must always stamp vale_review_passed_at (unblock the build claim-gate)",
      why:
        "A spec that passes Vale review can silently never build. The build claim-gate only launches a " +
        "build when the spec carries a durable review-passed stamp, but some pass paths record the review " +
        "as passed without setting that stamp. Observed live on the mario-pipeline-plumbing goal: three " +
        "member specs passed review yet their builds re-queued every 90 seconds forever, with 7 of 10 " +
        "build lanes idle, until a human hand-stamped the flag. This is exactly the queued-job-never-" +
        "claimed failure the Mario goal targets, and it will recur for any spec that passes through the " +
        "same path.",
      what:
        "Every Vale pass durably records the review-passed stamp so a passed spec is always claimable, " +
        "plus a claim-gate backstop so a passed-but-unstamped spec self-heals instead of re-queueing " +
        "indefinitely.",
      summary:
        "Guarantee the durable review-passed stamp on every spec-review pass, and add a claim-gate " +
        "backstop that distinguishes genuinely-unreviewed specs from passed-but-unstamped ones. " +
        "Grounded in scripts/builder-worker.ts:5560 (claimHeldForUnreviewedSpec) + :50 " +
        "(BUILD_GATE_HOLD_COOLDOWN_MS), src/lib/brain-roadmap.ts:744 (valeReviewPassed derivation), " +
        "src/lib/spec-card-state.ts:609 (markSpecCardValePassed), src/lib/agents/spec-dispose.ts:135-218 " +
        "(adaDispositionFor / applyAdaDispositionDecision author-intent fallback).",
      owner: "platform",
      parent:
        '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: a passed spec that never ' +
        "builds is a silent pipeline reliability failure the build platform must not allow.",
      critical: true,
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Stamp the review-passed flag on every pass, and root-cause the divergence",
          why:
            "The build claim-gate cannot launch a spec that lacks the durable review-passed stamp, so any " +
            "pass path that omits it is a silent build stall. Two goal-member specs were stamped and built " +
            "while three passed review yet stayed unstamped — that divergence must be found and closed at " +
            "the source.",
          what:
            "A Vale pass always records the durable review-passed stamp before Ada's disposition runs, " +
            "including the author-intent fallback branch where no Vale disposition recommendation was " +
            "emitted, and that stamp survives the disposition.",
          body:
            "Root-cause why the mario-* member specs recorded a spec_review_passed director_activity row " +
            "yet vale_review_passed_at stayed NULL while M1/M2 did not. Fix the source so every pass " +
            "durably stamps the flag via markSpecCardValePassed (src/lib/spec-card-state.ts:609). Confirm " +
            "vale_review_passed_at is NOT consumed by Ada's disposition (src/lib/agents/spec-dispose.ts " +
            "applyAdaDispositionDecision → applyAdaDisposition), unlike vale_pass. The author-intent " +
            "fallback lives at spec-dispose.ts:141-148. Update the relevant docs/brain/ page(s) " +
            "(agents-spec-review / spec-dispose / the build-gate lifecycle) in the same PR per the " +
            "CLAUDE.md brain rule.",
          verification:
            "Author a fresh test spec and drive it through spec-review to a PASS: assert " +
            "specs.vale_review_passed_at is non-NULL immediately after the pass AND after Ada's " +
            "disposition runs, and that its build job is claimed (leaves status='queued' → 'building') " +
            "within one poll cycle rather than re-queued with a future claimed_at.",
          status: "planned",
        },
        {
          title: "Phase 2 — Claim-gate backstop: passed-but-unstamped self-heals, not re-queues forever",
          why:
            "Even after Phase 1, a stray unstamped-but-passed spec must not silently loop forever. The " +
            "gate should tell a genuinely-unreviewed spec apart from one that passed review but lost its " +
            "stamp, and heal the latter instead of re-queueing it every 90 seconds.",
          what:
            "Before holding a build, the claim-gate checks whether the spec already passed review; if it " +
            "did but the stamp is missing, it repairs the stamp and lets the build proceed, while a " +
            "genuinely-unreviewed spec is still held as today.",
          body:
            "In claimHeldForUnreviewedSpec (scripts/builder-worker.ts:5560), before holding, check for a " +
            "spec_review_passed director_activity row for the slug; if one exists but " +
            "vale_review_passed_at is NULL, stamp it via markSpecCardValePassed (self-heal) and proceed to " +
            "launch rather than re-queue, logging the heal to director_activity. Keep the genuine-" +
            "unreviewed hold behavior intact (no spec_review_passed row → still held with cooldown). " +
            "Update the build-gate brain page.",
          verification:
            "Simulate a spec with a spec_review_passed director_activity row and vale_review_passed_at=NULL: " +
            "assert the claim loop stamps it and launches the build (not a re-queue with future " +
            "claimed_at), and that a spec with NO spec_review_passed row is still correctly held.",
          status: "planned",
        },
      ],
    },
    "planned",
    {
      intendedStatusSetBy: "ceo",
      parentKind: "mandate",
      parentRef: "platform#infra-devops-reliability",
      autoBuild: true,
    },
  );
  console.log(ok ? "authored (critical, auto_build)" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
