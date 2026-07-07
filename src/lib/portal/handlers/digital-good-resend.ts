/**
 * Portal handler — resend a downloadable digital good the customer owns.
 *
 * Phase 3 of docs/brain/specs/digital-goods-delivery.md. The customer clicks
 * "resend my download" from the portal; this handler:
 *
 *   1. Requires an authenticated portal session (auth.loggedInCustomerId).
 *   2. Resolves the caller → our customer_id → link-group.
 *   3. Delegates the two-part OWNERSHIP guard + Resend send to
 *      resendDigitalGoodForOwner() in the delivery library:
 *        (a) order.customer_id ∈ link group
 *        (b) order.line_items references the digital_good_id
 *      Both MUST hold — a miss on either returns "not_owned" (surfaced here
 *      as a 404 so we don't leak "which of the two failed").
 *   4. Logs a customer_event on success (audit trail for user-initiated resend).
 *
 * A customer who does not own the good CANNOT resend it — the ownership guard
 * lives inside resendDigitalGoodForOwner, which reads
 * (workspace_id, id) on orders (link-group scope) AND the JSONB line-items
 * reference — both are required.
 */

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan, logPortalAction } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { resendDigitalGoodForOwner } from "@/lib/inngest/digital-goods-delivery";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const digitalGoodResend: RouteHandler = async ({ auth, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }
  const orderId = String((payload?.orderId ?? payload?.order_id ?? "") as string).trim();
  const digitalGoodId = String((payload?.digitalGoodId ?? payload?.digital_good_id ?? "") as string).trim();
  if (!orderId || !UUID_RE.test(orderId)) return jsonErr({ error: "missing_orderId" }, 400);
  if (!digitalGoodId || !UUID_RE.test(digitalGoodId)) return jsonErr({ error: "missing_digitalGoodId" }, 400);

  // Resolve the caller → our customer_id → link-group. Same shape as
  // order-detail.ts — a customer can trigger actions for THEIR link group
  // (self + any linked profile in the same customer_links.group_id).
  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);
  const admin = createAdminClient();
  let ownerCustomerIds: string[] = [customer.id];
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customer.id)
    .maybeSingle();
  if (link?.group_id) {
    const { data: group } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id);
    ownerCustomerIds = (group || []).map((r) => r.customer_id as string);
    if (!ownerCustomerIds.includes(customer.id)) ownerCustomerIds.push(customer.id);
  }

  const res = await resendDigitalGoodForOwner({
    workspaceId: auth.workspaceId,
    orderId,
    ownerCustomerIds,
    digitalGoodId,
  });

  // Map the resend result → HTTP response. "not_owned" surfaces as 404 so we
  // don't leak "the order exists but you can't touch it" vs "no such order".
  if (res.status === "not_owned") return jsonErr({ error: "order_not_found" }, 404);
  if (res.status === "not_a_downloadable") return jsonErr({ error: "not_a_downloadable" }, 400);
  if (res.status === "skipped_missing_asset") return jsonErr({ error: "asset_unavailable", detail: res.error }, 502);
  if (res.status === "skipped_resend_unavailable") return jsonErr({ error: "email_unavailable" }, 502);
  if (res.status === "failed") return jsonErr({ error: "resend_failed", detail: res.error }, 500);

  // Success — audit-log the resend.
  await logPortalAction({
    workspaceId: auth.workspaceId,
    customerId: customer.id,
    eventType: "portal.digital_good_resend",
    summary: `Resent digital good ${digitalGoodId} for order ${orderId}`,
    properties: {
      order_id: orderId,
      digital_good_id: digitalGoodId,
      resend_email_id: res.resend_email_id ?? null,
    },
  });

  return jsonOk({ ok: true, resend_email_id: res.resend_email_id ?? null });
};
