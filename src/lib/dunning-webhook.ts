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
      .select("shopify_contract_id")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customer.id)
      .in("status", ["active", "paused"]);

    if (activeSubs?.length) {
      const { appstleSwitchPaymentMethod } = await import("@/lib/appstle");
      for (const sub of activeSubs) {
        try {
          await appstleSwitchPaymentMethod(workspaceId, sub.shopify_contract_id, paymentMethodId);
          console.log(`Payment method webhook: switched sub ${sub.shopify_contract_id} to ${paymentMethodId}`);
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
