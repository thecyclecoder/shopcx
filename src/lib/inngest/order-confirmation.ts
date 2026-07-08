/**
 * Order-confirmation sender for Shopify-sourced orders (Klaviyo
 * replacement — the first of the transactional sends we're reclaiming
 * from the sunset Klaviyo).
 *
 * Phase 4 of the shopify-order-confirmation-emails spec. Fires on the
 * `order/confirmation.requested` event that
 * `src/lib/shopify-webhooks.ts` enqueues at the end of every
 * newly-seen + paid orders/create webhook (mirroring the existing
 * fraud/demographics fire-and-forget pattern, line ~747). Body:
 * `{ workspaceId, orderId }`.
 *
 * Handler shape (per the spec):
 *
 *   1. Load the order row (Phase-1 `ORDER_EMAIL_ROW_COLS` plus
 *      `tags`, `financial_status`, `order_confirmation_email_id` for
 *      the guards).
 *   2. Skip if already sent (`order_confirmation_email_id` set — the
 *      Phase-3 dedupe key), if the row isn't a Shopify order, if
 *      `financial_status` isn't paid (defence in depth — the
 *      enqueuer also gates on this), if the email is missing, or if
 *      the order is tagged wholesale/test.
 *   3. Resolve the `OrderForEmail` payload + send inputs via
 *      Phase-1 `getShopifyOrderEmailData`.
 *   4. Send via `sendOrderConfirmationEmail` (Phase 3's return shape
 *      hands back `resendEmailId`).
 *   5. On success, stamp `orders.order_confirmation_email_id` +
 *      `order_confirmation_sent_at` — the Phase-3 tracking columns.
 *      A follow-up invocation for the same order short-circuits at
 *      step 2.
 *
 * Flood-safety: `concurrency: 5` per workspace + `throttle: 10 req/s`
 * respects Resend's ~10 req/s rate limit, so the daily 50–100
 * subscription-renewal burst can't hammer Resend or cause 429s. See
 * docs/brain/inngest/order-confirmation.md.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";
import { sendOrderConfirmationEmail } from "@/lib/email-storefront";
import {
  getShopifyOrderEmailData,
  ORDER_EMAIL_ROW_COLS,
} from "@/lib/order-confirmation-data";

type SkipReason =
  | "order_not_found"
  | "not_shopify_order"
  | "already_sent"
  | "not_paid"
  | "missing_email"
  | "wholesale_or_test";

interface OrderRowForConfirmation {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  shopify_order_id: string | null;
  order_number: string | null;
  email: string | null;
  total_cents: number | null;
  line_items: unknown;
  shipping_address: unknown;
  shipping_method_code: string | null;
  payment_details: unknown;
  subscription_id: string | null;
  shipping_protection_added: boolean | null;
  shipping_protection_amount_cents: number | null;
  source_name: string | null;
  amplifier_tracking_number: string | null;
  amplifier_carrier: string | null;
  tags: string | null;
  financial_status: string | null;
  order_confirmation_email_id: string | null;
}

const GUARD_TAG_PATTERNS = ["wholesale", "test"] as const;

/** Case-insensitive substring match against a comma-separated Shopify tags string. */
function tagsMatch(tags: string | null | undefined): boolean {
  if (!tags) return false;
  const lower = tags.toLowerCase();
  return GUARD_TAG_PATTERNS.some((p) => lower.includes(p));
}

export const orderConfirmationSend = inngest.createFunction(
  {
    id: "order-confirmation-send",
    name: "Storefront — send order-confirmation email (Shopify orders)",
    retries: 3,
    // Cap per-workspace parallel sends so a rush of subscription
    // renewals from one workspace can't starve others.
    concurrency: [{ limit: 5, key: "event.data.workspaceId" }],
    // Resend allows ~10 req/s per key; keep global throttle just
    // under the ceiling so retries have headroom.
    throttle: { limit: 8, period: "1s" },
    triggers: [{ event: "order/confirmation.requested" }],
  },
  async ({ event, step }) => {
    let __ctOk = true;
    try {
      const { workspaceId, orderId } = event.data as {
        workspaceId: string;
        orderId: string;
      };

      const order = await step.run("load-order", async () => {
        const admin = createAdminClient();
        const { data } = await admin
          .from("orders")
          .select(
            `${ORDER_EMAIL_ROW_COLS}, tags, financial_status, order_confirmation_email_id`,
          )
          .eq("workspace_id", workspaceId)
          .eq("id", orderId)
          .maybeSingle();
        return (data as OrderRowForConfirmation | null) || null;
      });

      if (!order) return { skipped: "order_not_found" satisfies SkipReason };
      if (!order.shopify_order_id) return { skipped: "not_shopify_order" satisfies SkipReason };
      if (order.order_confirmation_email_id) {
        return {
          skipped: "already_sent" satisfies SkipReason,
          resendEmailId: order.order_confirmation_email_id,
        };
      }
      if ((order.financial_status || "").toLowerCase() !== "paid") {
        return { skipped: "not_paid" satisfies SkipReason };
      }
      if (!order.email) return { skipped: "missing_email" satisfies SkipReason };
      if (tagsMatch(order.tags)) {
        return { skipped: "wholesale_or_test" satisfies SkipReason };
      }

      const resolved = await step.run("resolve-order-email-data", async () => {
        return await getShopifyOrderEmailData(order);
      });

      const sendResult = await step.run("send-email", async () => {
        return await sendOrderConfirmationEmail({
          workspaceId,
          order: resolved.order,
          isFirstOrder: resolved.isFirstOrder,
          subscribing: resolved.subscribing,
          nextBillingDate: resolved.nextBillingDate,
        });
      });

      if (!sendResult.success) {
        // Non-fatal outcomes (resend not configured for the workspace,
        // sandbox blocking a recipient) — log and return, no retry. A
        // real send failure surfaces as an Error thrown by the send
        // step so Inngest retries with backoff.
        if (sendResult.error === "resend_not_configured_or_blocked") {
          return { skipped: "resend_not_configured_or_blocked", error: sendResult.error };
        }
        // Everything else is treated as retryable so the throttle
        // policy applies to the retry too.
        __ctOk = false;
        throw new Error(
          `sendOrderConfirmationEmail failed: ${sendResult.error || "unknown"}`,
        );
      }

      const resendEmailId = sendResult.resendEmailId || null;

      await step.run("stamp-confirmation-tracking", async () => {
        const admin = createAdminClient();
        // Compare-and-set on `order_confirmation_email_id IS NULL` so
        // a concurrent invocation that raced past the guard read
        // can't overwrite the first-stamp (this stamp is the dedupe
        // key — if it flips twice, `already_sent` never fires and we
        // double-send on the next replay).
        const nowIso = new Date().toISOString();
        const { data: updated } = await admin
          .from("orders")
          .update({
            order_confirmation_email_id: resendEmailId,
            order_confirmation_sent_at: nowIso,
          })
          .eq("workspace_id", workspaceId)
          .eq("id", orderId)
          .is("order_confirmation_email_id", null)
          .select("id");
        // Also mirror an `email_events` row so the delivered/opened
        // pipeline can attach the send. `order_id` column added in
        // Phase 3's migration.
        if (resendEmailId) {
          await admin.from("email_events").insert({
            workspace_id: workspaceId,
            customer_id: order.customer_id,
            order_id: orderId,
            resend_email_id: resendEmailId,
            event_type: "sent",
            event_at: nowIso,
            metadata: {
              order_number: order.order_number,
              subject_key: "order_confirmation",
            },
          });
        }
        return { stamped: (updated?.length || 0) > 0 };
      });

      return {
        sent: true,
        resendEmailId,
        usedGraphQL: resolved.usedGraphQL,
      };
    } catch (err) {
      __ctOk = false;
      throw err;
    } finally {
      await emitReactiveHeartbeat("order-confirmation-send", { ok: __ctOk });
    }
  },
);
