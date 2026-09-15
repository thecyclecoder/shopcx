// Handle Shopify customer_payment_methods/create and /update webhooks
// When a customer adds or updates a payment method, check if they have active dunning cycles
// and trigger recovery if so.

import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export async function handlePaymentMethodEvent(
  workspaceId: string,
  payload: Record<string, unknown>,
) {
  // Shopify payment method webhook payload includes customer_id at the top level
  const customerId = payload.customer_id ? String(payload.customer_id) : null;
  const paymentMethodId = payload.admin_graphql_api_id ? String(payload.admin_graphql_api_id) : null;

  if (!customerId) {
    console.log("Payment method webhook: no customer_id in payload");
    return;
  }

  const admin = createAdminClient();

  // Look up customer by shopify_customer_id
  const { data: customer } = await admin
    .from("customers")
    .select("id, shopify_customer_id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_customer_id", customerId)
    .single();

  if (!customer) {
    console.log(`Payment method webhook: customer ${customerId} not found in workspace`);
    return;
  }

  // Mirror the customer's Shopify cards into customer_payment_methods so the
  // portal / dashboard / orchestrator can see them. Dunning rotation reads
  // cards live from Shopify, but everything else reads this table — and it
  // was Braintree-only until now, so Appstle customers' cards were invisible.
  try {
    const { syncShopifyPaymentMethods } = await import("@/lib/dunning");
    const { synced } = await syncShopifyPaymentMethods(workspaceId, customer.id, customerId);
    console.log(`Payment method webhook: synced ${synced} Shopify card(s) for customer ${customerId}`);
  } catch (err) {
    console.error("Payment method webhook: card sync failed (non-fatal):", err);
  }

  // Auto-switch all active subscriptions to the new payment method
  if (paymentMethodId) {
    const { data: activeSubs } = await admin
      .from("subscriptions")
      .select("shopify_contract_id, billing_source")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customer.id)
      .in("status", ["active", "paused"]);

    if (activeSubs?.length) {
      const { subscriptionSwitchPaymentMethod } = await import("@/lib/commerce/subscription");
      for (const sub of activeSubs) {
        // ⚠️ `paymentMethodId` here is a BRAINTREE payment-method id. A ShopCX sub is billed by
        // Shopify, whose contract references a `gid://shopify/CustomerPaymentMethod/…` — wrapping
        // a Braintree id in that shape produces a gid for a method that does not exist, and the
        // mutation's userError was being discarded by the bare `await` below. So "customer added
        // a card, we repointed their subscriptions" silently did not happen for ShopCX subs, and
        // nothing said so. A ShopCX card change goes through Shopify's own update flow instead.
        if (sub.billing_source === "shopcx") {
          console.warn(
            `Payment method webhook: sub ${sub.shopify_contract_id} is ShopCX-billed — a Braintree method cannot be attached to a Shopify contract; skipping`,
          );
          continue;
        }
        try {
          // ⚠️ READ the result. This returns {success:false,error} rather than throwing, so a
          // bare await reports success for every failure.
          const r = await subscriptionSwitchPaymentMethod(workspaceId, sub.shopify_contract_id, paymentMethodId);
          if (r.success) {
            console.log(`Payment method webhook: switched sub ${sub.shopify_contract_id}`);
          } else {
            console.error(`Payment method webhook: switch REFUSED for ${sub.shopify_contract_id}: ${r.error}`);
          }
        } catch (err) {
          console.error(`Payment method webhook: failed to switch sub ${sub.shopify_contract_id}:`, err);
        }
      }
    }
  }

  // Check if this customer has any dunning cycles worth recovering.
  // 'exhausted' is included on purpose: a sub that dunning *cancelled*
  // leaves its cycle 'exhausted', and dunning/new-card-recovery is built to
  // reactivate those (it resumes the cancelled sub + bills the new card).
  // Gating only on active/skipped meant a customer adding a card after their
  // sub was cancelled never auto-reactivated — the exact case we kept hitting.
  const { data: activeCycles } = await admin
    .from("dunning_cycles")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customer.id)
    .in("status", ["active", "skipped", "exhausted"]);

  if (!activeCycles?.length) {
    console.log(`Payment method webhook: no recoverable dunning cycles for customer ${customerId}`);
    return;
  }

  console.log(`Payment method webhook: customer ${customerId} has ${activeCycles.length} recoverable dunning cycle(s), triggering recovery`);

  // Fire dunning recovery event
  await inngest.send({
    name: "dunning/new-card-recovery",
    data: {
      workspace_id: workspaceId,
      customer_id: customer.id,
      shopify_customer_id: customerId,
      payment_method_id: paymentMethodId,
    },
  });
}
