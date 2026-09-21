// Handle Shopify customer_payment_methods/create and /update webhooks
// When a customer adds or updates a payment method, check if they have active dunning cycles
// and trigger recovery if so.

import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { RECOVERABLE_DUNNING_STATUSES } from "@/lib/dunning";

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
        // ⭐ ENGINE RANKING: internal (Braintree) > shopcx (our Shopify app) > appstle. Promotion
        // to internal happens on the BRAINTREE side — `vaultAndMigratePaymentMethod` sweeps a
        // customer's appstle AND shopcx subs onto internal rails the moment they vault a card.
        // This webhook is the other direction and cannot promote anything.
        //
        // ⚠️ This is the SHOPIFY `customer_payment_methods` webhook: `paymentMethodId` is
        // `payload.admin_graphql_api_id`, i.e. a `gid://shopify/CustomerPaymentMethod/…`. So it is
        // meaningful to the two Shopify-billed engines and MEANINGLESS to the internal one —
        // `internalSubSwitchPaymentMethod` treats its argument as a `customer_payment_methods`
        // row / Braintree token and would promote a Shopify gid to the customer's default card.
        //
        // (A pre-merge review read this the other way round and had ShopCX skipped here — i.e.
        // skipping the engine it actually works for. Corrected 2026-09-15; the handler has exactly
        // one caller, `api/webhooks/shopify/route.ts`, so the id's provenance is not ambiguous.)
        if (sub.billing_source === "internal") {
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
  //
  // Derived from RECOVERABLE_DUNNING_STATUSES (= OPEN_DUNNING_STATUSES + 'exhausted')
  // so this gate can never drift from getActiveDunningCyclesForCustomer / the
  // handler again — before 2026-09-21 the hard-coded ['active','skipped','exhausted']
  // list here silently disagreed with the handler that BOTH selects AND explicitly
  // handles 'retrying'. All five stranded cycles on 2026-09-21 were 'retrying', so
  // even a Shopify card update was being refused at this gate.
  //
  // 'exhausted' stays included on purpose: a sub that dunning *cancelled* leaves
  // its cycle 'exhausted', and dunning/new-card-recovery is built to reactivate
  // those (it resumes the cancelled sub + bills the new card).
  //
  // closed_reason IS NULL discipline: a cycle closed by a customer pause/cancel
  // (or by the migration orphan sweep) carries a closed_reason and MUST NOT be
  // resurrected.
  const { data: activeCycles } = await admin
    .from("dunning_cycles")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customer.id)
    .in("status", RECOVERABLE_DUNNING_STATUSES as unknown as string[])
    .is("closed_reason", null);

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
