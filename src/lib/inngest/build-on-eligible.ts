/**
 * build-on-eligible — reactive companion to the platform-director every-5min cron for the build lane
 * ([[../specs/bo-reactive-gated-build-enqueue]] Phase 2).
 *
 * The build lane's chokepoint is `enqueueBuildIfDue` ([[../libraries/agent-jobs]]): a cheap SDK
 * gate on build-eligibility (`specReviewDone` + `!deferred` + `auto_build !== false` + blockers
 * cleared + not shipped) followed by a one-in-flight guard. Phase 1 routed the un-gated reactive
 * site (`autoQueueUnblockedBy`) through that chokepoint; this phase adds the OTHER half of the
 * reactive+gated pattern the [[../specs/vale-reactive-spec-review]] sibling spec uses for Vale —
 * fire an event on the transitions that make a spec build-eligible, run the gate on receipt.
 *
 * Trigger: `build/spec-build-eligible` (fired-and-forgotten from `markSpecCardValePassed` and
 * `applyAdaDisposition('planned')` in [[../libraries/spec-card-state]]). Body: a single call to
 * `enqueueBuildIfDue(workspace_id, slug)` — which re-checks the FULL eligibility gate, so a Vale
 * pass alone is safe to fire on: if the spec still needs Ada's disposition, this no-ops for free,
 * and the second event (from Ada) re-fires when it lands. The every-5min platform-director cron
 * ([[platform-director-cron]]) remains the gated backstop for dropped events / cold workspaces —
 * its lanes already gate on `specReviewDone`, so there's no double-enqueue risk.
 *
 * Concurrency `{ limit: 1, key: 'event.data.workspace_id' }` mirrors the growth-ad-spend-governor
 * sweep shape — one build-eligibility check per workspace at a time; a burst of transitions on the
 * same workspace serializes into a single ordered chain and Ada's cron picks up any drop.
 */
import { inngest } from "@/lib/inngest/client";
import { enqueueBuildIfDue } from "@/lib/agent-jobs";

export const buildOnEligible = inngest.createFunction(
  {
    id: "build-on-eligible",
    name: "Build — reactive enqueue on the review-pass / disposition transition",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "build/spec-build-eligible" }],
  },
  async ({ event, step }) => {
    const { workspace_id, slug } = event.data as { workspace_id: string; slug: string };
    if (!workspace_id || !slug) return { status: "skipped", reason: "missing workspace_id or slug" };

    const result = await step.run("enqueue-build-if-due", async () => {
      const r = await enqueueBuildIfDue(workspace_id, slug);
      return r;
    });

    console.log(
      `[build-on-eligible] ws=${workspace_id} slug=${slug} enqueued=${result.enqueued} reason=${result.reason ?? ""}`,
    );
    return { status: "complete", ...result };
  },
);
