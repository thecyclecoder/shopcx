/**
 * spec-review-on-mutate — RETIRED.
 *
 * Vale's reactive-on-mutation lane is retired ([[../libraries/spec-review-gate]] · [[../specs/retire-vale-
 * spec-review-becomes-deterministic-authoring-gate]] Phase 2). The DETERMINISTIC gate runs synchronously
 * inside `authorSpecRowStructured` / `authorSpecRowFromMarkdown`, so there is no separate LLM review
 * event to enqueue. A well-formed spec is build-eligible on the instant its author call returns; a
 * malformed spec was rejected in-line by `SpecReviewGateError`.
 *
 * Kept as a no-op stub so `registered-functions.ts` still resolves the export; the function's trigger
 * has been replaced with an unreachable event id so nothing dispatches into it. Phase 3 deletes this
 * file outright.
 */
import { inngest } from "@/lib/inngest/client";

// Retired stub — no consumer, no work.
export const specReviewOnMutate = inngest.createFunction(
  {
    id: "spec-review-on-mutate-retired",
    name: "Spec-review on-mutate — RETIRED (deterministic gate at authoring)",
    retries: 0,
    concurrency: [{ limit: 1 }],
    // Unreachable event — the deterministic gate replaces this lane; the emit sites (author-spec) will be
    // dropped in the same PR.
    triggers: [{ event: "spec-review/RETIRED-never-fired" }],
  },
  async () => {
    return { retired: true };
  },
);
