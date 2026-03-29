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

  // Check if this customer has any active dunning cycles
  const { data: activeCycles } = await admin
    .from("dunning_cycles")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customer.id)
    .in("status", ["active", "skipped"]);

  if (!activeCycles?.length) {
    console.log(`Payment method webhook: no active dunning cycles for customer ${customerId}`);
    return;
  }

  console.log(`Payment method webhook: customer ${customerId} has ${activeCycles.length} active dunning cycle(s), triggering recovery`);

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
