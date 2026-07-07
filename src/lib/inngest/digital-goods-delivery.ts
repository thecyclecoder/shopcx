/**
 * Post-purchase attachment delivery for downloadable digital goods.
 *
 * Phase 2 of docs/brain/specs/digital-goods-delivery.md. Fires on the
 * `orders/created` event that the /api/checkout route sends after it inserts
 * an order. For each downloadable digital good on the order's `line_items`
 * JSONB (identified by an optional `digital_good_id` field on a line), the
 * function:
 *
 *   1. Consults the pre-dispatch idempotency guard against
 *      public.digital_good_deliveries by (workspace_id, order_id,
 *      digital_good_id). A hit short-circuits — no duplicate email.
 *   2. Reads the digital_goods row and asserts it is a downloadable with an
 *      asset_path + delivery='attachment'. (The Phase 1 CHECK constraints
 *      already pin the two legal row shapes; this is defence-in-depth.)
 *   3. Downloads the asset from Supabase Storage server-side (never signs a
 *      URL out to the customer) — same admin.storage.from(...).download(...)
 *      pattern used by src/lib/inngest/import-subscriptions.ts.
 *   4. Sends a single Resend email with the file attached. From-line matches
 *      the storefront transactional convention (orders@{resend_domain}).
 *   5. Writes the delivery ledger row — the DB-level unique (order_id,
 *      digital_good_id) index is the race-safe backstop.
 *
 * Exactly one Resend email per (order, digital_good) is the invariant Phase 2
 * verification asserts; the ledger + unique index + pre-dispatch guard are its
 * three layers.
 *
 * Same shape as [[../libraries/refund]] `refundOrder` — check ledger, act on
 * external side-effect, write mirror. See docs/brain/inngest/digital-goods-delivery.md.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getResendClient } from "@/lib/email";

/** Bucket that holds the digital-good assets. Kept private (no anon path); the
 *  delivery function is the only reader and it downloads server-side. */
export const DIGITAL_GOODS_BUCKET = "digital-goods";

export type DigitalGoodDeliveryStatus =
  | "delivered"
  | "skipped_already_delivered"
  | "skipped_not_downloadable"
  | "skipped_missing_asset"
  | "skipped_resend_unavailable"
  | "failed";

export interface DigitalGoodDeliveryResult {
  order_id: string;
  digital_good_id: string;
  status: DigitalGoodDeliveryStatus;
  resend_email_id?: string | null;
  error?: string;
}

interface DeliverDigitalGoodOnceInput {
  workspaceId: string;
  orderId: string;
  orderNumber: string | null;
  customerEmail: string;
  digitalGoodId: string;
  /** Override the default bucket (test seam). */
  bucket?: string;
}

/**
 * Deliver ONE downloadable digital good on an order, idempotent per
 * (order, digital_good). Extracted from the Inngest handler so Phase 3's
 * portal-resend action can reuse it AND so Phase 2's idempotency invariant
 * has a testable unit boundary.
 */
export async function deliverDigitalGoodOnce(
  input: DeliverDigitalGoodOnceInput,
): Promise<DigitalGoodDeliveryResult> {
  const admin = createAdminClient();
  const bucket = input.bucket || DIGITAL_GOODS_BUCKET;

  // 1. Pre-dispatch idempotency guard — mirrors [[../libraries/refund]]
  //    refundOrder's ledger read shape (same three-layer defence: read → act →
  //    mirror-insert; unique index is the race-safe backstop).
  const { data: existing } = await admin
    .from("digital_good_deliveries")
    .select("id, resend_email_id")
    .eq("workspace_id", input.workspaceId)
    .eq("order_id", input.orderId)
    .eq("digital_good_id", input.digitalGoodId)
    .maybeSingle();
  if (existing) {
    return {
      order_id: input.orderId,
      digital_good_id: input.digitalGoodId,
      status: "skipped_already_delivered",
      resend_email_id: (existing as { resend_email_id?: string | null }).resend_email_id ?? null,
    };
  }

  // 2. Resolve the good and defensively re-check the two-legal-shapes
  //    invariant (Phase 1 CHECK constraints pin this at the DB — this belt +
  //    suspenders keeps a mis-shaped row from ever landing an empty email).
  const { data: good } = await admin
    .from("digital_goods")
    .select("id, name, type, asset_path, delivery")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.digitalGoodId)
    .maybeSingle();
  if (!good) {
    return {
      order_id: input.orderId,
      digital_good_id: input.digitalGoodId,
      status: "failed",
      error: "digital_good_not_found",
    };
  }
  const g = good as { name: string; type: string; asset_path: string | null; delivery: string };
  if (g.type !== "downloadable" || g.delivery !== "attachment" || !g.asset_path) {
    return {
      order_id: input.orderId,
      digital_good_id: input.digitalGoodId,
      status: "skipped_not_downloadable",
    };
  }

  // 3. Download the asset server-side. Same pattern as import-subscriptions.ts.
  const dl = await admin.storage.from(bucket).download(g.asset_path);
  if (dl.error || !dl.data) {
    return {
      order_id: input.orderId,
      digital_good_id: input.digitalGoodId,
      status: "skipped_missing_asset",
      error: dl.error?.message || "asset_download_failed",
    };
  }
  const buf = Buffer.from(await dl.data.arrayBuffer());
  const filename = ((g.asset_path.split("/").pop() || `${g.name}.pdf`).replace(/[^A-Za-z0-9._-]/g, "_"));

  // 4. Send the Resend email with the file attached. getResendClient also
  //    enforces sandbox_mode — a non-workspace-member recipient in sandbox is
  //    dropped before send. That's fine: the ledger is only written on
  //    Resend success so a skip won't record a phantom delivery.
  const client = await getResendClient(input.workspaceId, input.customerEmail);
  if (!client) {
    return {
      order_id: input.orderId,
      digital_good_id: input.digitalGoodId,
      status: "skipped_resend_unavailable",
    };
  }
  const admin2 = createAdminClient();
  const { data: ws } = await admin2
    .from("workspaces")
    .select("transactional_from_name, name")
    .eq("id", input.workspaceId)
    .single();
  const brandName =
    ((ws as { transactional_from_name?: string | null } | null)?.transactional_from_name) ||
    ((ws as { name?: string | null } | null)?.name) ||
    "Superfoods Company";
  const orderRef = input.orderNumber ? ` for order ${input.orderNumber}` : "";
  const subject = `Your download: ${g.name}`;
  const html =
    `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; ` +
    `max-width: 480px; margin: 0 auto; padding: 32px 20px; color:#18181b;">` +
    `<h2 style="font-size: 20px; margin-bottom: 8px;">Your ${escapeHtml(g.name)}</h2>` +
    `<p style="color:#52525b; font-size: 14px; line-height: 1.6;">Thanks for your purchase${escapeHtml(orderRef)}. ` +
    `Your download is attached to this email.</p>` +
    `<p style="color:#a1a1aa; font-size: 12px; margin-top: 24px;">If you have any trouble opening the file, reply to this email and we'll get it to you.</p>` +
    `</div>`;

  const send = await client.resend.emails.send({
    from: `${brandName} <orders@${client.domain}>`,
    to: input.customerEmail,
    subject,
    html,
    attachments: [{ filename, content: buf }],
  });
  if (send.error) {
    return {
      order_id: input.orderId,
      digital_good_id: input.digitalGoodId,
      status: "failed",
      error: send.error.message,
    };
  }
  const resendEmailId = (send.data as { id?: string } | null)?.id ?? null;

  // 5. Write the ledger row. The unique (order_id, digital_good_id) index is
  //    the DB backstop — a concurrent invocation that raced past the guard
  //    lands here with a 23505 constraint violation; we log and treat the
  //    delivery as duplicated (the email is out either way).
  const { error: insertErr } = await admin
    .from("digital_good_deliveries")
    .insert({
      workspace_id: input.workspaceId,
      order_id: input.orderId,
      digital_good_id: input.digitalGoodId,
      resend_email_id: resendEmailId,
      delivered_at: new Date().toISOString(),
    });
  if (insertErr) {
    console.warn(
      `[digital-goods-delivery] ledger insert failed for order=${input.orderId} good=${input.digitalGoodId}: ${insertErr.message}`,
    );
  }

  return {
    order_id: input.orderId,
    digital_good_id: input.digitalGoodId,
    status: "delivered",
    resend_email_id: resendEmailId,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Extract the distinct digital_good_id references from an order's `line_items`
 * JSONB. Exported so both the Inngest handler and tests share the same reader.
 * A line is a digital-good line iff it carries a string `digital_good_id`; we
 * don't consult `type` here — deliverDigitalGoodOnce re-checks and skips a
 * non-downloadable row.
 */
export function extractDigitalGoodIds(lineItems: unknown): string[] {
  if (!Array.isArray(lineItems)) return [];
  const ids = new Set<string>();
  for (const li of lineItems) {
    const id = li && typeof li === "object" && typeof (li as Record<string, unknown>).digital_good_id === "string"
      ? ((li as Record<string, unknown>).digital_good_id as string)
      : null;
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

export const digitalGoodsDelivery = inngest.createFunction(
  {
    id: "digital-goods-delivery",
    name: "Storefront — deliver downloadable digital goods on order-created",
    retries: 3,
    concurrency: [{ limit: 5, key: "event.data.workspaceId" }],
    triggers: [{ event: "orders/created" }],
  },
  async ({ event, step }) => {
    const { orderId, workspaceId } = event.data as { orderId: string; workspaceId: string };

    const order = await step.run("load-order", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("orders")
        .select("id, order_number, email, line_items")
        .eq("workspace_id", workspaceId)
        .eq("id", orderId)
        .maybeSingle();
      return data as { id: string; order_number: string | null; email: string | null; line_items: unknown } | null;
    });
    if (!order) return { skipped: "order_not_found" };

    const goodIds = extractDigitalGoodIds(order.line_items);
    if (!goodIds.length) return { deliveries: [] };

    const customerEmail = String(order.email || "");
    if (!customerEmail) return { skipped: "order_email_missing" };

    // Per-good delivery. Inngest's step id keeps a retry from re-firing a
    // completed per-good delivery even before the DB ledger is consulted;
    // the DB ledger + unique index is the cross-invocation backstop.
    const results: DigitalGoodDeliveryResult[] = [];
    for (const goodId of goodIds) {
      const res = await step.run(`deliver-${goodId}`, () =>
        deliverDigitalGoodOnce({
          workspaceId,
          orderId,
          orderNumber: order.order_number,
          customerEmail,
          digitalGoodId: goodId,
        }),
      );
      results.push(res);
    }
    return { deliveries: results };
  },
);
