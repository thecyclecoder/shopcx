/**
 * Post-order review-ask send handler — Phase 2 of
 * [[../../../docs/brain/specs/review-request-post-order-ask]].
 *
 * The Phase-1 detector cron fires ONE `review/post-order.ask-due` Inngest
 * event per qualifying candidate; THIS handler consumes those events and
 * runs the shared apply-path ([[review-request-sender]] `applyReviewRequest`)
 * — the same trigger-agnostic pipeline the ticket-side Phase-2 apply-path
 * will call.
 *
 * Node-completeness (CLAUDE.md hard rule):
 *   1. Owner `cmo` (Iris's review-collection mandate) — registered in
 *      [[../control-tower/node-registry]] via a `kind:'reactive'`
 *      MONITORED_LOOPS row.
 *   2. Kill switch — `enforceSwitch("post-order-review-ask-send")` is the
 *      first body statement. A blocked cascade emits a `blocked_off`
 *      heartbeat + returns; the switch resolver's polarity ⇒ missing row = ON.
 *   3. Heartbeat — `emitReactiveHeartbeat` at the end of every event
 *      handler run so the CT watchdog can see the reactive lane beating.
 *
 * Guard-before-mutation: the payload's ids are UNTRUSTED capabilities. Every
 * mutating call inside `applyReviewRequest` re-asserts its precondition
 * (journey active, ladder empty, product+customer workspace-scoped) before
 * writing, so a malformed / cross-workspace event cannot leak through.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";
import { errText } from "@/lib/error-text";
import {
  applyReviewRequest,
  type ApplyReviewRequestResult,
} from "@/lib/review-request-sender";
import type { ReviewRequestWindow } from "@/lib/review-request-compose";
import { POST_ORDER_REVIEW_ASK_EVENT } from "./post-order-review-ask-detector-cron";

/**
 * Post-order default angle. Sol picks the ticket-trigger angle per-customer
 * off the thread; the post-order trigger has no thread, so the default is
 * `fence-sitter` — the leaner phrasing that leans on the customer's tenure
 * + the product rather than an antagonist claim. A future refinement can
 * switch to a per-customer decision once we ship a post-order box session.
 */
export const POST_ORDER_DEFAULT_ANGLE = "fence-sitter" as const;

/** Guard — every id-shaped payload field must be a non-empty string. */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Guard — the window label the detector attached is one of the two
 * classifier outputs (or null when the detector omitted it). */
function normalizeWindow(v: unknown): ReviewRequestWindow {
  return v === "first-time" || v === "repeat" ? v : null;
}

export const postOrderReviewAskSend = inngest.createFunction(
  {
    id: "post-order-review-ask-send",
    name: "Post-order review-ask send — reactive handler for review/post-order.ask-due",
    retries: 2,
    concurrency: [{ limit: 3 }],
    triggers: [{ event: POST_ORDER_REVIEW_ASK_EVENT }],
  },
  async ({ event, step }: { event: { data?: Record<string, unknown> }; step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> } }) => {
    // Node-completeness rule #2: enforceSwitch as the FIRST body statement.
    if (
      (await enforceSwitch("post-order-review-ask-send")).ok === "blocked_off"
    ) {
      return { skipped: "blocked_off" };
    }

    // Payload validation — every field is UNTRUSTED. A malformed event is
    // dropped as a `skipped:'invalid_payload'` result rather than throwing
    // (retrying a malformed payload won't help — the fields are the same
    // on every retry).
    const raw = (event.data ?? {}) as Record<string, unknown>;
    const workspaceId = raw.workspace_id;
    const customerId = raw.customer_id;
    const productId = raw.product_id;
    if (
      !isNonEmptyString(workspaceId) ||
      !isNonEmptyString(customerId) ||
      !isNonEmptyString(productId)
    ) {
      const result = { skipped: "invalid_payload" as const };
      await step.run("emit-heartbeat", async () => {
        await emitReactiveHeartbeat("post-order-review-ask-send", {
          ok: true,
          produced: result,
        });
      });
      return result;
    }
    const window = normalizeWindow(raw.window);
    const orderId = isNonEmptyString(raw.order_id) ? raw.order_id : null;

    const applyResult = await step.run("apply-post-order-review-request", async () => {
      const admin = createAdminClient();
      try {
        return await applyReviewRequest(admin, {
          workspaceId,
          customerId,
          productId,
          angle: POST_ORDER_DEFAULT_ANGLE,
          // The post-order first-touch does not carry a coupon; the reward
          // is minted at submit-time by the review-journey (a customer-
          // scoped $5 code), so a coupon in the ask itself would be a
          // second reward — not what the spec asks for.
          includeCoupon: false,
          context: {
            type: "post-order",
            window,
            orderId,
          },
        });
      } catch (e) {
        console.error(
          `[post-order-review-ask-send] apply threw for customer=${customerId.slice(
            0,
            8,
          )} product=${productId.slice(0, 8)}: ${errText(e)}`,
        );
        return {
          outcome: "skipped_customer_missing" as const,
        } satisfies ApplyReviewRequestResult;
      }
    });

    await step.run("emit-heartbeat", async () => {
      await emitReactiveHeartbeat("post-order-review-ask-send", {
        ok: true,
        produced: { apply: applyResult.outcome },
      });
    });

    return applyResult;
  },
);
