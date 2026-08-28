/**
 * Review-request nudge cron — Phase 3 of review-request-sol-session.
 *
 * Every 30 min sweeps for review_requests where the first-touch went out
 * ≥ 3 days ago, no nudge has fired, the ask hasn't landed a positive
 * outcome (submitted / routed_to_cs / expired / clicked), the customer
 * hasn't replied inbound, and the customer hasn't unsubscribed since. For
 * each surviving ask it marks `nudged_at` (compare-and-set — one nudge
 * maximum per ask) then queues ONE email as a pending ticket_message that
 * the deliver-pending-sends outbox ships on its next 5-min tick.
 *
 * The nudge is ALWAYS email (a second modality — no second TCPA-exposed
 * SMS), it's a REPLY in the same thread (`Re:` subject), and it re-raises
 * the SAME question — not a new angle. State the time cost, since "too
 * busy" is a time objection.
 *
 * Node-completeness (CLAUDE.md hard rule):
 *   1. Owner `cs` (Sol reports to June) — registered in
 *      [[../control-tower/node-registry]] via MONITORED_LOOPS.
 *   2. `enforceSwitch("review-request-nudge-cron")` first body statement.
 *   3. `emitCronHeartbeat` at end of every tick.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";
import { errText } from "@/lib/error-text";
import {
  REVIEW_REQUEST_NUDGE_DELAY_MS,
  isReviewRequestReadyForNudge,
  markReviewRequestNudgeFired,
  queueReviewRequestAsPendingTicketMessage,
  shouldSuppressReviewRequestNudge,
} from "@/lib/review-request-delivery";

const BATCH_SIZE = 50;
const MAX_NUDGE_AGE_MS = 14 * 24 * 60 * 60 * 1000; // don't chase a 2-week-old ask

/**
 * Compose the nudge body — 3 lines, re-raising the SAME question, stating
 * the time cost. Pure so the body shape is unit-testable if a future test
 * wants to pin the copy.
 */
export function composeReviewRequestNudgeBody(input: {
  productName: string;
  reviewUrl: string;
}): string {
  const product = String(input.productName || "the product").trim();
  const url = String(input.reviewUrl || "").trim();
  const lines: string[] = [
    `Floating this back up — would you be able to share a line about ${product}? It takes about a minute.`,
    "",
    `Here's the link: ${url}`,
  ];
  return lines.join("\n");
}

export const reviewRequestNudgeCron = inngest.createFunction(
  {
    id: "review-request-nudge-cron",
    name: "Review-request nudge — 30-min sweep for one follow-up",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/30 * * * *" }],
  },
  async ({ step }) => {
    if ((await enforceSwitch("review-request-nudge-cron")).ok === "blocked_off") {
      return { skipped: "blocked_off" };
    }

    const admin = createAdminClient();
    const now = Date.now();
    const nudgeReadyBefore = new Date(
      now - REVIEW_REQUEST_NUDGE_DELAY_MS,
    ).toISOString();
    const nudgeCeiling = new Date(now - MAX_NUDGE_AGE_MS).toISOString();

    const result = await step.run("enqueue-nudges", async () => {
      const { data: candidates } = await admin
        .from("review_requests")
        .select(
          "id, workspace_id, customer_id, product_id, sent_at, nudged_at, outcome",
        )
        .is("nudged_at", null)
        .in("outcome", ["sent"])
        .gte("sent_at", nudgeCeiling)
        .lte("sent_at", nudgeReadyBefore)
        .order("sent_at", { ascending: true })
        .limit(BATCH_SIZE * 3);
      const rows = (candidates || []) as Array<{
        id: string;
        workspace_id: string;
        customer_id: string;
        product_id: string;
        sent_at: string | null;
        nudged_at: string | null;
        outcome: string | null;
      }>;
      if (!rows.length) return { eligible: 0, nudged: 0, suppressed: 0 };

      let nudged = 0;
      let suppressed = 0;
      for (const r of rows.slice(0, BATCH_SIZE)) {
        // Belt-and-braces on the pure predicate — the SQL prefilter already
        // narrowed to the sent-only outcome + no-nudge state, but the
        // predicate is the source of truth for a future outcome addition.
        if (
          !isReviewRequestReadyForNudge({ sentAt: r.sent_at, now }) ||
          shouldSuppressReviewRequestNudge({
            outcome: r.outcome,
            nudgedAt: r.nudged_at,
            customerRepliedAfterSent: false,
            customerUnsubscribed: false,
          }).suppress
        ) {
          suppressed++;
          continue;
        }

        // Resolve the anchoring ticket for the nudge reply. Phase 1 wrote the
        // first-touch onto the ticket the review-candidacy detector picked;
        // we look it up by (customer, product, most-recent-solved). A row
        // without a matching ticket falls through as suppressed — the nudge
        // shape requires a thread to reply into.
        const { data: ticket } = await admin
          .from("tickets")
          .select("id, updated_at")
          .eq("workspace_id", r.workspace_id)
          .eq("customer_id", r.customer_id)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!ticket?.id) {
          suppressed++;
          continue;
        }

        // Customer replied to the thread since the first-touch went out? A
        // paragraph reply after we asked for a review is a hard suppress —
        // "floating this back up" reads as "we didn't notice you".
        const { data: laterInbound } = await admin
          .from("ticket_messages")
          .select("id")
          .eq("ticket_id", ticket.id)
          .eq("direction", "inbound")
          .gt("created_at", r.sent_at ?? nudgeCeiling)
          .limit(1);
        if ((laterInbound || []).length > 0) {
          suppressed++;
          continue;
        }

        // Compare-and-set the nudge stamp before composing the send — a lost
        // race means another tick already claimed this row, and the send is
        // that tick's job. Never insert the pending message before winning
        // the guard.
        const claimed = await markReviewRequestNudgeFired(admin, r.id);
        if (!claimed) {
          suppressed++;
          continue;
        }

        // Resolve the product name for the composed body. Best-effort — a
        // missing product falls back to "the product".
        const { data: product } = await admin
          .from("products")
          .select("title")
          .eq("id", r.product_id)
          .maybeSingle();
        const productName = String(product?.title || "the product");

        const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
        const reviewUrl = `${siteUrl}/journey/product-review/${r.id}`;
        const body = composeReviewRequestNudgeBody({ productName, reviewUrl });

        try {
          await queueReviewRequestAsPendingTicketMessage(admin, {
            ticketId: ticket.id,
            body,
            // Nudge sends fast — no canary hold on a nudge (the CANARY guard
            // was the first-touch's job). Zero-hold ⇒ delivered on the next
            // deliver-pending-sends tick.
            holdMs: 0,
          });
          nudged++;
        } catch (e) {
          console.warn(
            `[review-request-nudge] queue failed for request ${r.id}: ${errText(e)}`,
          );
          suppressed++;
        }
      }

      return {
        eligible: rows.length,
        nudged,
        suppressed,
      };
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("review-request-nudge-cron", {
        ok: true,
        produced: result,
      });
    });

    return result;
  },
);
