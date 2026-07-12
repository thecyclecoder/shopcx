/**
 * spec-review-cron — RETIRED.
 *
 * Vale (the LLM spec-review lane) has been retired in favor of the DETERMINISTIC spec-review gate that
 * runs at the authoring chokepoint ([[../libraries/spec-review-gate]] · [[../specs/retire-vale-spec-
 * review-becomes-deterministic-authoring-gate]] Phase 1 + Phase 2). A well-formed spec passes the gate
 * synchronously at author time; a malformed spec never reaches `public.specs`. There is no periodic LLM
 * queue for Vale to sweep anymore.
 *
 * This module is kept as a no-op stub so any lingering registration path or dashboard reference resolves
 * without a hard import error, but the Inngest function no longer fires anything — the trigger is removed
 * from `registered-functions.ts` and this stub does no work.
 */
import { inngest } from "@/lib/inngest/client";

// Retired stub — no cron trigger, no work. Kept exported so a stale reference imports without a build
// break; downstream removal (Phase 3) drops this file entirely.
export const specReviewCron = inngest.createFunction(
  {
    id: "spec-review-cron-retired",
    name: "Spec-review cron — RETIRED (deterministic gate at authoring)",
    retries: 0,
    concurrency: [{ limit: 1 }],
    // No trigger — this function will never execute.
    triggers: [{ event: "spec-review/RETIRED-never-fired" }],
  },
  async () => {
    // No-op: the deterministic authoring gate ([[../libraries/spec-review-gate]]) replaces this lane.
    return { retired: true };
  },
);
