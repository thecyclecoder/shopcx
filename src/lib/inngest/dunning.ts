// Inngest dunning functions: payment-failed orchestration, new-card recovery, billing-success cleanup

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchSlackNotification } from "@/lib/slack-notify";
import {
  getCustomerPaymentMethods,
  deduplicatePaymentMethods,
  getUntriedCards,
  getNextPaydayDates,
  getRetryTime,
  getDunningSettings,
  getActiveDunningCycle,
  createDunningCycle,
  updateDunningCycle,
  logPaymentFailure,
  getLastSuccessfulCard,
  getActiveDunningCyclesForCustomer,
  dunningInternalNote,
} from "@/lib/dunning";
import {
  appstleAttemptBilling,
  appstleSkipUpcomingOrder,
  appstleUnskipOrder,
  appstleSwitchPaymentMethod,
  appstleSendPaymentUpdateEmail,
  appstleGetUpcomingOrders,
  appstleSubscriptionAction,
} from "@/lib/appstle";
import {
  sendDunningPaymentUpdateEmail,
  sendDunningRecoveryEmail,
  sendDunningPausedEmail,
} from "@/lib/email";
import { addTicketTag } from "@/lib/ticket-tags";

// ── dunning/payment-failed ──
// Triggered by billing-failure webhook. Orchestrates the full dunning flow.

export const dunningPaymentFailed = inngest.createFunction(
  {
    id: "dunning-payment-failed",
    retries: 2,
    concurrency: [{ limit: 3, key: "event.data.workspace_id" }],
    triggers: [{ event: "dunning/payment-failed" }],
  },
  async ({ event, step }) => {
    const {
      workspace_id,
      shopify_contract_id,
      subscription_id,
      customer_id,
      shopify_customer_id,
      billing_attempt_id,
      error_code,
      error_message,
    } = event.data as {
      workspace_id: string;
      shopify_contract_id: string;
      subscription_id: string | null;
      customer_id: string | null;
      shopify_customer_id: string | null;
      billing_attempt_id: string | null;
      error_code: string | null;
      error_message: string | null;
    };

    // Step 1: Check dunning settings
    const settings = await step.run("check-settings", async () => {
      return getDunningSettings(workspace_id);
    });

    if (!settings?.dunning_enabled) {
      return { status: "skipped", reason: "dunning_disabled" };
    }

    // Step 2: Check for existing active dunning cycle (avoid double-processing)
    const existingCycle = await step.run("check-existing-cycle", async () => {
      return getActiveDunningCycle(workspace_id, shopify_contract_id);
    });

    if (existingCycle) {
      return { status: "skipped", reason: "active_cycle_exists", cycle_id: existingCycle.id };
    }

    // Step 3: Log initial failure + create dunning cycle
    const cycle = await step.run("create-dunning-cycle", async () => {
      await logPaymentFailure({
        workspaceId: workspace_id,
        customerId: customer_id,
        subscriptionId: subscription_id,
        shopifyContractId: shopify_contract_id,
        billingAttemptId: billing_attempt_id,
        errorCode: error_code,
        errorMessage: error_message,
        attemptNumber: 1,
        attemptType: "initial",
        succeeded: false,
      });

      const c = await createDunningCycle(
        workspace_id,
        shopify_contract_id,
        subscription_id,
        customer_id,
        billing_attempt_id,
      );

      // Post internal note on ticket if one exists for this customer
      await postDunningNote(workspace_id, customer_id, dunningInternalNote(
        `Payment failed on subscription ${shopify_contract_id}. Starting dunning cycle ${c.cycle_number} — trying other payment methods.`
      ));

      return c;
    });

    // Step 4: Get customer payment methods from Shopify
    if (!shopify_customer_id) {
      await step.run("no-customer-skip", async () => {
        await handleAllCardsExhausted(workspace_id, shopify_contract_id, customer_id, cycle, settings);
      });
      return { status: "exhausted", reason: "no_shopify_customer", cycle_id: cycle.id };
    }

    const paymentMethods = await step.run("get-payment-methods", async () => {
      try {
        const methods = await getCustomerPaymentMethods(workspace_id, shopify_customer_id);
        return deduplicatePaymentMethods(methods);
      } catch (err) {
        console.error("Failed to get payment methods:", err);
        return [];
      }
    });

    // Step 5: Card rotation — try each untried card with 2h delays
    // Note: billingAttempt success only means the API accepted the request,
    // NOT that the payment succeeded. Real success comes via billing-success webhook.
    // We rotate cards and wait — if a billing-success webhook fires, dunningBillingSuccess
    // will mark the cycle as recovered.
    const maxRotations = Math.min(settings.dunning_max_card_rotations, paymentMethods.length);
    let attemptNumber = 2; // #1 was the initial failure

    for (let i = 0; i < maxRotations; i++) {
      // Wait 2 hours between rotation attempts (except first)
      if (i > 0) {
        await step.sleep(`card-rotation-wait-${i}`, "2h");
      }

      // Reload cycle from DB (gets current cards_tried, handles function restarts)
      const cycleCheck = await step.run(`check-cycle-${i}`, async () => {
        return getActiveDunningCycle(workspace_id, shopify_contract_id);
      });
      if (!cycleCheck || cycleCheck.status === "recovered") break;

      // Get untried cards from DB state (not in-memory)
      const dbCardsTried = (cycleCheck.cards_tried as string[]) || [];
      const untried = getUntriedCards(paymentMethods, dbCardsTried);
      if (untried.length === 0) break;

      const card = untried[0];

      await step.run(`rotate-card-${i}`, async () => {
        const switchRes = await appstleSwitchPaymentMethod(workspace_id, shopify_contract_id, card.id);
        if (!switchRes.success) return;

        const ordersRes = await appstleGetUpcomingOrders(workspace_id, shopify_contract_id);
        if (!ordersRes.success || !ordersRes.orders?.length) return;

        const attemptId = ordersRes.orders[0].id;
        await appstleAttemptBilling(workspace_id, attemptId);

        // Log the attempt (not yet known if it succeeded — webhook will tell us)
        await logPaymentFailure({
          workspaceId: workspace_id,
          customerId: customer_id,
          subscriptionId: subscription_id,
          shopifyContractId: shopify_contract_id,
          billingAttemptId: attemptId,
          paymentMethodLast4: card.last4,
          paymentMethodId: card.id,
          attemptNumber,
          attemptType: "card_rotation",
          succeeded: false, // Will be updated by billing-success webhook
        });

        // Track tried card in DB (survives function restarts)
        const updatedTried = [...dbCardsTried, card.dedupeKey];
        await updateDunningCycle(cycleCheck.id, {
          cards_tried: updatedTried,
          billing_attempt_id: attemptId,
        });
      });

      attemptNumber++;
    }

    // Wait briefly for any billing-success webhook to fire from last rotation
    await step.sleep("post-rotation-wait", "30m");

    // Check if any card rotation succeeded (billing-success webhook would have updated the cycle)
    const postRotationCheck = await step.run("post-rotation-check", async () => {
      return getActiveDunningCycle(workspace_id, shopify_contract_id);
    });
    if (!postRotationCheck || postRotationCheck.status === "recovered") {
      return { status: "recovered", method: "card_rotation", cycle_id: cycle.id };
    }

    // Step 6: All cards exhausted — skip/pause + send emails + schedule payday retries
    await step.run("all-cards-exhausted", async () => {
      await handleAllCardsExhausted(workspace_id, shopify_contract_id, customer_id, cycle, settings);
    });

    // Step 7: Payday-aware retries (if enabled)
    if (settings.dunning_payday_retry_enabled) {
      const paydayDates = getNextPaydayDates(new Date(), 3);

      for (let i = 0; i < paydayDates.length; i++) {
        const retryTime = getRetryTime(paydayDates[i]);
        await step.sleepUntil(`payday-retry-wait-${i}`, retryTime);

        // Check if cycle was recovered externally (billing-success webhook or new card)
        const cycleCheck = await step.run(`check-cycle-payday-${i}`, async () => {
          return getActiveDunningCycle(workspace_id, shopify_contract_id);
        });
        if (!cycleCheck || cycleCheck.status === "recovered") break;

        await step.run(`payday-retry-${i}`, async () => {
          const lastCard = customer_id ? await getLastSuccessfulCard(workspace_id, customer_id) : null;
          const targetMethod = lastCard?.payment_method_id || paymentMethods[0]?.id;
          if (!targetMethod) return;

          await appstleSwitchPaymentMethod(workspace_id, shopify_contract_id, targetMethod);

          const ordersRes = await appstleGetUpcomingOrders(workspace_id, shopify_contract_id);
          if (!ordersRes.success || !ordersRes.orders?.length) return;

          const attemptId = ordersRes.orders[0].id;
          await appstleAttemptBilling(workspace_id, attemptId);

          await logPaymentFailure({
            workspaceId: workspace_id,
            customerId: customer_id,
            subscriptionId: subscription_id,
            shopifyContractId: shopify_contract_id,
            billingAttemptId: attemptId,
            paymentMethodLast4: lastCard?.payment_method_last4 || paymentMethods[0]?.last4 || null,
            paymentMethodId: targetMethod,
            attemptNumber: attemptNumber + i,
            attemptType: "payday_retry",
            succeeded: false, // Will be updated by billing-success webhook
          });

          await updateDunningCycle(cycleCheck.id, { billing_attempt_id: attemptId });
        });

        // Wait for billing result
        await step.sleep(`payday-result-wait-${i}`, "30m");

        const postPaydayCheck = await step.run(`post-payday-check-${i}`, async () => {
          return getActiveDunningCycle(workspace_id, shopify_contract_id);
        });
        if (!postPaydayCheck || postPaydayCheck.status === "recovered") break;
      }
    }

    // Final check — was the cycle recovered during payday retries?
    const finalCheck = await step.run("final-check", async () => {
      return getActiveDunningCycle(workspace_id, shopify_contract_id);
    });
    if (!finalCheck || finalCheck.status === "recovered") {
      return { status: "recovered", method: "payday_retry", cycle_id: cycle.id };
    }

    // Step 8: Exhausted — mark cycle
    await step.run("mark-exhausted", async () => {
      await updateDunningCycle(cycle.id, { status: "exhausted" });
    });

    // Slack notification for exhausted dunning
    dispatchSlackNotification(workspace_id, "dunning_failed", {
      customer: { email: customer_email || "" },
      attempts: cycle.cycle_number || 0,
    }).catch(() => {});

    return { status: "exhausted", cycle_id: cycle.id, cycle_number: cycle.cycle_number };
  }
);

// ── dunning/new-card-recovery ──
// Triggered by Shopify payment method create/update webhook

export const dunningNewCardRecovery = inngest.createFunction(
  {
    id: "dunning-new-card-recovery",
    retries: 2,
    concurrency: [{ limit: 3, key: "event.data.workspace_id" }],
    triggers: [{ event: "dunning/new-card-recovery" }],
  },
  async ({ event, step }) => {
    const {
      workspace_id,
      customer_id,
      payment_method_id,
    } = event.data as {
      workspace_id: string;
      customer_id: string;
      shopify_customer_id: string;
      payment_method_id: string | null;
    };

    // Step 1: Find active dunning cycles for this customer
    const activeCycles = await step.run("check-dunning-cycles", async () => {
      return getActiveDunningCyclesForCustomer(workspace_id, customer_id);
    });

    if (activeCycles.length === 0) {
      return { status: "no_active_cycles" };
    }

    const results: { contractId: string; recovered: boolean; error?: string }[] = [];

    // Step 2: For each active dunning cycle, unskip + switch card + retry
    for (const cycle of activeCycles) {
      const result = await step.run(`recover-${cycle.shopify_contract_id}`, async () => {
        try {
          // Unskip the order if it was skipped
          if (cycle.status === "skipped" && cycle.billing_attempt_id) {
            await appstleUnskipOrder(workspace_id, cycle.billing_attempt_id);
          }

          // If subscription was paused (cycle 2), resume it
          if (cycle.status === "paused" || cycle.cycle_number >= 2) {
            // Check if subscription is actually paused
            const admin = createAdminClient();
            const { data: sub } = await admin.from("subscriptions")
              .select("status")
              .eq("workspace_id", workspace_id)
              .eq("shopify_contract_id", cycle.shopify_contract_id)
              .single();

            if (sub?.status === "paused") {
              await appstleSubscriptionAction(workspace_id, cycle.shopify_contract_id, "resume");
            }
          }

          // Switch to new payment method if we have a specific ID
          if (payment_method_id) {
            await appstleSwitchPaymentMethod(workspace_id, cycle.shopify_contract_id, payment_method_id);
          }

          // Get upcoming order and trigger billing
          const ordersRes = await appstleGetUpcomingOrders(workspace_id, cycle.shopify_contract_id);
          if (!ordersRes.success || !ordersRes.orders?.length) {
            return { contractId: cycle.shopify_contract_id, recovered: false, error: "No upcoming orders" };
          }

          const attemptId = ordersRes.orders[0].id;
          const billingRes = await appstleAttemptBilling(workspace_id, attemptId);

          await logPaymentFailure({
            workspaceId: workspace_id,
            customerId: customer_id,
            subscriptionId: cycle.subscription_id,
            shopifyContractId: cycle.shopify_contract_id,
            billingAttemptId: attemptId,
            paymentMethodId: payment_method_id,
            attemptNumber: 1,
            attemptType: "new_card_retry",
            succeeded: billingRes.success,
          });

          if (billingRes.success) {
            await updateDunningCycle(cycle.id, { status: "recovered", recovered_at: new Date().toISOString() });
          }

          return { contractId: cycle.shopify_contract_id, recovered: billingRes.success };
        } catch (err) {
          console.error(`Recovery failed for contract ${cycle.shopify_contract_id}:`, err);
          return { contractId: cycle.shopify_contract_id, recovered: false, error: String(err) };
        }
      });

      results.push(result);
    }

    // Step 3: Notify recovery
    const anyRecovered = results.some(r => r.recovered);
    if (anyRecovered) {
      await step.run("notify-recovery", async () => {
        await postDunningNote(workspace_id, customer_id, dunningInternalNote(
          `Customer added new card. ${results.filter(r => r.recovered).length} subscription(s) recovered.`
        ));
        await tagCustomerTickets(workspace_id, customer_id, "dunning:recovered");

        // Send recovery email
        const admin = createAdminClient();
        const { data: customer } = await admin.from("customers").select("email, first_name").eq("id", customer_id).single();
        const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspace_id).single();
        if (customer?.email && ws?.name) {
          await sendDunningRecoveryEmail({
            workspaceId: workspace_id,
            toEmail: customer.email,
            customerName: customer.first_name,
            workspaceName: ws.name,
          });
        }
      });
    }

    return { status: anyRecovered ? "recovered" : "failed", results };
  }
);

// ── dunning/billing-success ──
// Triggered by billing-success webhook when a dunning cycle exists

export const dunningBillingSuccess = inngest.createFunction(
  {
    id: "dunning-billing-success",
    retries: 1,
    concurrency: [{ limit: 5, key: "event.data.workspace_id" }],
    triggers: [{ event: "dunning/billing-success" }],
  },
  async ({ event, step }) => {
    const {
      workspace_id,
      shopify_contract_id,
      customer_id,
    } = event.data as {
      workspace_id: string;
      shopify_contract_id: string;
      customer_id: string | null;
    };

    await step.run("close-dunning-cycle", async () => {
      const cycle = await getActiveDunningCycle(workspace_id, shopify_contract_id);
      if (!cycle) return;

      await updateDunningCycle(cycle.id, {
        status: "recovered",
        recovered_at: new Date().toISOString(),
      });

      await logPaymentFailure({
        workspaceId: workspace_id,
        customerId: customer_id,
        subscriptionId: null,
        shopifyContractId: shopify_contract_id,
        attemptNumber: 0,
        attemptType: "initial",
        succeeded: true,
      });

      await postDunningNote(workspace_id, customer_id, dunningInternalNote(
        `Payment succeeded for subscription ${shopify_contract_id}. Dunning cycle closed.`
      ));
      await tagCustomerTickets(workspace_id, customer_id, "dunning:recovered");
    });

    return { status: "recovered" };
  }
);

// ── Helpers ──

async function handleAllCardsExhausted(
  workspaceId: string,
  shopifyContractId: string,
  customerId: string | null,
  cycle: { id: string; cycle_number: number },
  settings: { dunning_cycle_1_action: string; dunning_cycle_2_action: string },
) {
  const admin = createAdminClient();
  const action = cycle.cycle_number >= 2 ? settings.dunning_cycle_2_action : settings.dunning_cycle_1_action;

  if (action === "skip") {
    // Skip the upcoming order
    await appstleSkipUpcomingOrder(workspaceId, shopifyContractId);
    await updateDunningCycle(cycle.id, { status: "skipped", skipped_at: new Date().toISOString() });
    await tagCustomerTickets(workspaceId, customerId, "dunning:skipped");
  } else if (action === "pause") {
    // Pause the subscription
    await appstleSubscriptionAction(workspaceId, shopifyContractId, "pause");
    await updateDunningCycle(cycle.id, { status: "paused", paused_at: new Date().toISOString() });
    await tagCustomerTickets(workspaceId, customerId, "dunning:paused");
  }

  // Send payment update email via Appstle (triggers Shopify secure link)
  await appstleSendPaymentUpdateEmail(workspaceId, shopifyContractId);
  await updateDunningCycle(cycle.id, { payment_update_sent: true, payment_update_sent_at: new Date().toISOString() });

  // Get customer + workspace info for our own email
  if (customerId) {
    const { data: customer } = await admin.from("customers").select("email, first_name, shopify_customer_id").eq("id", customerId).single();
    const { data: ws } = await admin.from("workspaces").select("name, shopify_myshopify_domain").eq("id", workspaceId).single();

    if (customer?.email && ws?.name && ws?.shopify_myshopify_domain) {
      const updateUrl = `https://${ws.shopify_myshopify_domain}/account`;

      if (action === "pause") {
        await sendDunningPausedEmail({
          workspaceId,
          toEmail: customer.email,
          customerName: customer.first_name,
          workspaceName: ws.name,
          updateUrl,
        });
      } else {
        await sendDunningPaymentUpdateEmail({
          workspaceId,
          toEmail: customer.email,
          customerName: customer.first_name,
          workspaceName: ws.name,
          updateUrl,
        });
      }
    }
  }

  // Post internal note
  const noteMsg = action === "pause"
    ? `All payment methods failed for 2 consecutive cycles. Subscription paused. Payment update email sent.`
    : `All payment methods failed. Order skipped. Payment update email sent.`;

  await postDunningNote(workspaceId, customerId, dunningInternalNote(noteMsg));
  await tagCustomerTickets(workspaceId, customerId, "dunning:active");

  // For cycle 2 (pause), also create ticket + dashboard notification
  if (action === "pause" && customerId) {
    const { data: customer } = await admin.from("customers").select("email, first_name, last_name").eq("id", customerId).single();

    // Create ticket for agent awareness
    await admin.from("tickets").insert({
      workspace_id: workspaceId,
      customer_id: customerId,
      subject: `Payment failure — subscription paused for ${customer?.first_name || customer?.email || "customer"}`,
      status: "open",
      channel: "email",
      tags: ["dunning:paused"],
    });

    // Create dashboard notification
    await admin.from("dashboard_notifications").insert({
      workspace_id: workspaceId,
      type: "system",
      title: "Subscription paused due to payment failure",
      body: `${customer?.first_name || "Customer"}'s subscription (${shopifyContractId}) paused after 2 failed billing cycles.`,
      metadata: { customer_id: customerId, shopify_contract_id: shopifyContractId },
    });
  }
}

async function postDunningNote(
  workspaceId: string,
  customerId: string | null,
  note: string,
) {
  if (!customerId) return;

  const admin = createAdminClient();

  // Find the most recent open/pending ticket for this customer
  const { data: ticket } = await admin
    .from("tickets")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("status", ["open", "pending"])
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!ticket) return;

  await admin.from("ticket_messages").insert({
    ticket_id: ticket.id,
    direction: "internal",
    visibility: "internal",
    author_type: "system",
    body: note,
  });
}

async function tagCustomerTickets(
  workspaceId: string,
  customerId: string | null,
  tag: string,
) {
  if (!customerId) return;

  const admin = createAdminClient();
  const { data: tickets } = await admin
    .from("tickets")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("status", ["open", "pending"]);

  if (!tickets?.length) return;

  for (const ticket of tickets) {
    await addTicketTag(ticket.id, tag);
  }
}
