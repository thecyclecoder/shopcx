/**
 * Canonical helper for creating a Shopify replacement order AND persisting
 * it to the `replacements` table.
 *
 * Use this EVERYWHERE we create a replacement — direct actions, playbook
 * steps, ad-hoc agent scripts, the agent-facing dashboard. The contract:
 *
 *   1. Insert a `replacements` row FIRST (status='pending') — guarantees
 *      a DB record exists even if the Shopify call fails or the process
 *      dies mid-flight.
 *   2. Create + complete the Shopify draft order.
 *   3. Update the row with the Shopify order name (status='created') OR
 *      mark it 'failed' with the error.
 *   4. Optionally write a [Manual action] system note on the ticket.
 *
 * This is the single source of truth: if a Shopify replacement order
 * exists, a `replacements` row exists for it. No silent gaps where the
 * order shipped but our system doesn't know.
 *
 * Why a record-first approach: previously the direct action inserted
 * AFTER the Shopify call inside a try/catch labeled "non-fatal". On any
 * insert failure (RLS, schema drift, network), the order shipped but
 * the row was lost. Record-first means the row exists for sure and the
 * Shopify call updates it with the outcome.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { loggedActionFetch } from "@/lib/appstle-call-log";
import { normalizeCountryToIso2 } from "@/lib/country-iso2";

export interface CreateReplacementInput {
  workspaceId: string;
  customerId: string;
  /** The Shopify customer ID we'll attach the new draft order to. */
  shopifyCustomerId: string;
  /** Required: variant + quantity to ship. */
  items: Array<{ variantId: string; quantity: number; title?: string }>;
  /** Required: shipping address. */
  shippingAddress: {
    firstName?: string; lastName?: string;
    address1: string; address2?: string;
    city: string; province?: string; provinceCode?: string;
    zip: string; countryCode?: string;
  };
  /** What kind of replacement this is (e.g. "not_received", "damaged_items", "crisis"). */
  reason: string;
  /** Original Shopify order this replaces (optional but recommended). */
  originalOrderNumber?: string | null;
  /** Ticket the replacement was driven from (for the audit trail). */
  ticketId?: string | null;
  /** Subscription id if this replaces a sub renewal order. */
  subscriptionId?: string | null;
  /** True if the original loss was due to the customer's mistake (e.g. wrong address). Limits future replacements per customer. */
  customerError?: boolean;
  /** Free-form note shown in Shopify. The ticket URL is auto-appended when ticketId is set. */
  shopifyNote?: string;
  /** Who triggered this. Goes into the ticket message + audit trail. */
  initiatedBy?: "ai" | "agent" | "script" | "playbook";
  /** Optional display name of the human (when initiatedBy='agent'/'script'). */
  initiatedByName?: string;
}

export interface CreateReplacementResult {
  success: boolean;
  replacementId: string;
  shopifyOrderName: string | null;
  error?: string;
}

export async function createReplacementOrder(input: CreateReplacementInput): Promise<CreateReplacementResult> {
  const admin = createAdminClient();

  // ── 1. Insert the row FIRST (record-first guarantee) ────────────────
  const initialItems = input.items.map(i => ({
    variantId: i.variantId,
    quantity: i.quantity,
    title: i.title || "item",
    type: "all",
  }));

  // Resolve internal original_order_id if we have an order number
  let originalOrderId: string | null = null;
  if (input.originalOrderNumber) {
    const { data } = await admin.from("orders")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .eq("order_number", input.originalOrderNumber)
      .maybeSingle();
    originalOrderId = data?.id || null;
  }

  const { data: replacement, error: insertErr } = await admin.from("replacements").insert({
    workspace_id: input.workspaceId,
    customer_id: input.customerId,
    original_order_id: originalOrderId,
    original_order_number: input.originalOrderNumber || null,
    reason: input.reason,
    items: initialItems,
    status: "pending",
    customer_error: !!input.customerError,
    ticket_id: input.ticketId || null,
    subscription_id: input.subscriptionId || null,
    address_validated: false,
    validated_address: input.shippingAddress,
  }).select("id").single();

  if (insertErr || !replacement) {
    return {
      success: false, replacementId: "",
      shopifyOrderName: null,
      error: `Failed to insert replacements row: ${insertErr?.message || "unknown"}`,
    };
  }

  // ── 2. Create + complete the Shopify draft order ──────────────────
  const { shop, accessToken } = await getShopifyCredentials(input.workspaceId);
  const shopifyGqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  const ticketLink = input.ticketId ? `\n\nTicket: ${siteUrl}/dashboard/tickets/${input.ticketId}` : "";
  const noteText = `${input.shopifyNote || "Replacement order"}${ticketLink}`;

  const draftBody = JSON.stringify({
    query: `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } } }`,
    variables: {
      input: {
        customerId: `gid://shopify/Customer/${input.shopifyCustomerId}`,
        lineItems: input.items.map(i => ({ variantId: `gid://shopify/ProductVariant/${i.variantId}`, quantity: i.quantity })),
        shippingAddress: {
          firstName: input.shippingAddress.firstName || "",
          lastName: input.shippingAddress.lastName || "",
          address1: input.shippingAddress.address1,
          address2: input.shippingAddress.address2 || "",
          city: input.shippingAddress.city,
          provinceCode: input.shippingAddress.provinceCode || input.shippingAddress.province || "",
          zip: input.shippingAddress.zip,
          countryCode: normalizeCountryToIso2(input.shippingAddress.countryCode),
        },
        note: noteText,
        tags: ["replacement", input.reason],
        appliedDiscount: { value: 100.0, valueType: "PERCENTAGE", title: "Replacement" },
      },
    },
  });

  const draftRes = await loggedActionFetch(shopifyGqlUrl, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: draftBody,
  }, {
    endpoint: "shopify:draftOrderCreate",
    bodySuccessCheck: (body) => {
      try {
        const d = JSON.parse(body);
        if (d?.errors?.length) return false;
        if (d?.data?.draftOrderCreate?.userErrors?.length) return false;
        return !!d?.data?.draftOrderCreate?.draftOrder?.id;
      } catch { return false; }
    },
  });
  const draftData = await draftRes.json();
  if (draftData.data?.draftOrderCreate?.userErrors?.length) {
    const errMsg = draftData.data.draftOrderCreate.userErrors.map((e: { message: string }) => e.message).join(", ");
    await admin.from("replacements").update({ status: "failed", reason_detail: `draftOrderCreate: ${errMsg}` }).eq("id", replacement.id);
    return { success: false, replacementId: replacement.id, shopifyOrderName: null, error: errMsg };
  }
  const draftId = draftData.data?.draftOrderCreate?.draftOrder?.id;
  if (!draftId) {
    const reason = draftData?.errors?.[0]?.message || JSON.stringify(draftData).slice(0, 300);
    await admin.from("replacements").update({ status: "failed", reason_detail: `no draftId: ${reason}` }).eq("id", replacement.id);
    return { success: false, replacementId: replacement.id, shopifyOrderName: null, error: `Draft order creation returned no draftId: ${reason}` };
  }

  const completeRes = await loggedActionFetch(shopifyGqlUrl, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `mutation { draftOrderComplete(id: "${draftId}") { draftOrder { order { name } } userErrors { message } } }` }),
  }, {
    endpoint: "shopify:draftOrderComplete",
    bodySuccessCheck: (body) => {
      try {
        const d = JSON.parse(body);
        if (d?.errors?.length) return false;
        if (d?.data?.draftOrderComplete?.userErrors?.length) return false;
        return !!d?.data?.draftOrderComplete?.draftOrder?.order?.name;
      } catch { return false; }
    },
  });
  const completeData = await completeRes.json();
  const orderName = completeData.data?.draftOrderComplete?.draftOrder?.order?.name || null;

  // ── 3. Stamp the row with the final state ────────────────────────
  await admin.from("replacements").update({
    shopify_draft_order_id: draftId,
    shopify_replacement_order_name: orderName,
    status: orderName ? "created" : "draft_completed_no_order",
  }).eq("id", replacement.id);

  return { success: !!orderName, replacementId: replacement.id, shopifyOrderName: orderName };
}
