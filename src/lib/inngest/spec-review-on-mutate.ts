/**
 * spec-review-on-mutate — the REACTIVE trigger for the box-hosted spec-review agent (Vale).
 *
 * [[../specs/vale-reactive-spec-review]] Phase 2: fire-and-forget `spec-review/spec-mutated` events land
 * here from the two mutation chokepoints that create or re-open an `in_review` spec (`author-spec.ts` after
 * a successful `upsertSpec`, and `spec-card-state.ts` `markSpecCardBackToReview` on any send-back). The
 * consumer calls the SAME gated helper the 15-min cron uses (`enqueueSpecReviewIfDue`), so:
 *
 *   - a mutation on a spec whose CURRENT content already carries `vale_pass=true` no-ops instantly and for
 *     free (the free SDK check inside the helper is the whole point of the gate — no Max session spins up);
 *   - a mutation that lands fresh/unreviewed content enqueues a `kind='spec-review'` `agent_jobs` row
 *     within seconds instead of up to 15 minutes (the cron becomes a catch-up backstop for dropped events /
 *     cold workspaces / new Inngest syncs — same relationship as spec-test-on-ship + spec-test-cron);
 *   - the `enqueueSpecReviewIfDue` one-in-flight guard makes this idempotent against a racing cron tick
 *     (no pile-up if the two triggers fire close together).
 *
 * Retries: 1 — the enqueue helper is idempotent; a transient DB blip retries once and the 15-min cron
 * backstop covers the rest. Concurrency: `{ limit: 1, key: 'event.data.workspace_id' }` — a burst of
 * mutations in one workspace collapses to one enqueue check at a time (still idempotent), and mutations
 * in other workspaces run in parallel.
 */
import { inngest } from "@/lib/inngest/client";
import { enqueueSpecReviewIfDue } from "@/lib/agents/spec-review";

export const specReviewOnMutate = inngest.createFunction(
  {
    id: "spec-review-on-mutate",
    name: "Spec-review — reactive enqueue on spec create / re-open",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "spec-review/spec-mutated" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string };
    const result = await step.run("enqueue", () => enqueueSpecReviewIfDue(workspace_id));
    return { workspace_id, ...result };
  },
);
