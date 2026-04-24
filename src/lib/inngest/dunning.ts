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
  isTerminalErrorCode,
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
      cycle_id,
    } = event.data as {
      workspace_id: string;
      shopify_contract_id: string;
      subscription_id: string | null;
      customer_id: string | null;
      shopify_customer_id: string | null;
      billing_attempt_id: string | null;
      error_code: string | null;
      error_message: string | null;
      cycle_id?: string;
    };

    // Step 1: Check dunning settings
    const settings = await step.run("check-settings", async () => {
      return getDunningSettings(workspace_id);
    });

    if (!settings?.dunning_enabled) {
      return { status: "skipped", reason: "dunning_disabled" };
    }

    // Step 2: Load the cycle created by the webhook handler, or check for existing
    const cycle = await step.run("load-dunning-cycle", async () => {
      if (cycle_id) {
        // Cycle was pre-created by the webhook handler (race-safe via unique index)
        const admin = createAdminClient();
        const { data } = await admin
          .from("dunning_cycles")
          .select("id, cycle_number")
          .eq("id", cycle_id)
          .single();
        if (!data) return null;

        // Log initial failure
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

        // Post internal note
        await postDunningNote(workspace_id, customer_id, dunningInternalNote(
          `Payment failed on subscription ${shopify_contract_id}. Starting dunning cycle ${data.cycle_number} — trying other payment methods.`
        ));

        return data;
      }

      // Legacy path: cycle not pre-created (backwards compat with in-flight events)
      const existing = await getActiveDunningCycle(workspace_id, shopify_contract_id);
      if (existing) return null; // Already exists, skip

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

      await postDunningNote(workspace_id, customer_id, dunningInternalNote(
        `Payment failed on subscription ${shopify_contract_id}. Starting dunning cycle ${c.cycle_number} — trying other payment methods.`
      ));

      return c;
    });

    if (!cycle) {
      return { status: "skipped", reason: "active_cycle_exists" };
    }

    // Step 3: Check if error code is terminal
    const isTerminal = await step.run("check-terminal-error", async () => {
      return isTerminalErrorCode(workspace_id, error_code);
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
        const deduped = deduplicatePaymentMethods(methods);
        console.log(`[Dunning] Contract ${shopify_contract_id}: ${methods.length} payment methods, ${deduped.length} after dedup for customer ${shopify_customer_id}`);
        if (deduped.length === 0) {
          console.log(`[Dunning] WARNING: 0 payment methods returned for customer ${shopify_customer_id}. Raw methods:`, JSON.stringify(methods));
        }
        return deduped;
      } catch (err) {
        console.error(`[Dunning] CRITICAL: getCustomerPaymentMethods failed for customer ${shopify_customer_id} (contract ${shopify_contract_id}):`, String(err));
        return [];
      }
    });

    // Step 4b: If terminal error + only 1 card → cancel immediately (no point rotating)
    if (isTerminal && paymentMethods.length <= 1) {
      await step.run("terminal-single-card-cancel", async () => {
        await updateDunningCycle(cycle.id, {
          status: "exhausted",
          terminal_error_code: error_code,
        });

        // Cancel subscription — recovery webhook will reactivate if customer adds new card
        await appstleSubscriptionAction(
          workspace_id, shopify_contract_id, "cancel", "dunning",
          `Cancelled by ShopCX — terminal billing error: ${error_code} (${error_message || "no details"}), no other payment methods available`
        );

        // Send payment update email so customer can add a new card
        await appstleSendPaymentUpdateEmail(workspace_id, shopify_contract_id).catch(() => {});

        const admin = createAdminClient();
        const { data: customer } = await admin.from("customers").select("email, first_name").eq("id", customer_id).single();
        const { data: ws } = await admin.from("workspaces").select("name, portal_config").eq("id", workspace_id).single();
        const portalGeneral = (ws?.portal_config as Record<string, unknown>)?.general as Record<string, unknown> | undefined;
        const updateUrl = (portalGeneral?.payment_update_url as string) || "";
        if (customer?.email && ws?.name && updateUrl) {
          await sendDunningPausedEmail({
            workspaceId: workspace_id,
            toEmail: customer.email,
            customerName: customer.first_name,
            workspaceName: ws.name,
            updateUrl,
          });
        }

        await postDunningNote(workspace_id, customer_id, dunningInternalNote(
          `Terminal billing error: ${error_code}. Customer has only ${paymentMethods.length} payment method(s). Subscription cancelled — will auto-reactivate if customer adds a new payment method.`
        ));
        await tagCustomerTickets(workspace_id, customer_id, "dunning:terminal");
      });

      return { status: "terminal", error_code, cycle_id: cycle.id };
    }

    // If terminal but customer has other cards, log it and let rotation try them
    if (isTerminal) {
      await step.run("terminal-flag-default-card", async () => {
        await postDunningNote(workspace_id, customer_id, dunningInternalNote(
          `Terminal billing error: ${error_code} on default card. Customer has ${paymentMethods.length} payment methods — rotating to try others.`
        ));
      });
    }

    // Step 5: Card rotation — try each untried card with 2h delays
    const maxRotations = Math.min(settings.dunning_max_card_rotations, paymentMethods.length);
    console.log(`[Dunning] Contract ${shopify_contract_id}: maxRotations=${maxRotations} (settings=${settings.dunning_max_card_rotations}, methods=${paymentMethods.length})`);
    let attemptNumber = 2; // #1 was the initial failure

    for (let i = 0; i < maxRotations; i++) {
      // Wait 2 hours between rotation attempts (except first)
      if (i > 0) {
        // Update next_retry_at so the DB reflects when next attempt happens
        await step.run(`set-next-retry-${i}`, async () => {
          await updateDunningCycle(cycle.id, {
            next_retry_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          });
        });
        await step.sleep(`card-rotation-wait-${i}`, "2h");
      }

      // Reload cycle from DB (gets current cards_tried + terminal_cards, handles function restarts)
      const cycleCheck = await step.run(`check-cycle-${i}`, async () => {
        return getActiveDunningCycle(workspace_id, shopify_contract_id);
      });
      if (!cycleCheck || cycleCheck.status === "recovered") break;

      // Check if all payment methods are terminal (webhooks mark cards terminal between rotations)
      const terminalCards = (cycleCheck.terminal_cards as string[]) || [];
      const allTerminal = paymentMethods.length > 0 && paymentMethods.every(m => terminalCards.includes(m.last4));
      if (allTerminal) {
        console.log(`[Dunning] All ${paymentMethods.length} cards are terminal for ${shopify_contract_id} — skipping remaining rotations`);
        break;
      }

      // Get untried cards from DB state (not in-memory)
      const dbCardsTried = (cycleCheck.cards_tried as string[]) || [];
      const untried = getUntriedCards(paymentMethods, dbCardsTried);
      if (untried.length === 0) break;

      const card = untried[0];

      await step.run(`rotate-card-${i}`, async () => {
        const switchRes = await appstleSwitchPaymentMethod(workspace_id, shopify_contract_id, card.id);
        if (!switchRes.success) {
          console.log(`[Dunning] Card switch rejected for ${shopify_contract_id} → ${card.last4}: ${switchRes.error}`);
          // Still track the card as tried even if switch failed
          const updatedTried = [...dbCardsTried, card.dedupeKey];
          await updateDunningCycle(cycleCheck.id, { cards_tried: updatedTried });
          return;
        }

        const ordersRes = await appstleGetUpcomingOrders(workspace_id, shopify_contract_id);
        if (!ordersRes.success || !ordersRes.orders?.length) {
          console.log(`[Dunning] No upcoming orders for ${shopify_contract_id}: ${ordersRes.error || "empty"}`);
          return;
        }

        const attemptId = ordersRes.orders[0].id;
        const billingRes = await appstleAttemptBilling(workspace_id, attemptId);

        // Log the attempt — includes whether Appstle accepted or rejected it
        await logPaymentFailure({
          workspaceId: workspace_id,
          customerId: customer_id,
          subscriptionId: subscription_id,
          shopifyContractId: shopify_contract_id,
          billingAttemptId: attemptId,
          paymentMethodLast4: card.last4,
          paymentMethodId: card.id,
          errorCode: billingRes.success ? null : "appstle_rejected",
          errorMessage: billingRes.success ? "Billing attempt accepted by Appstle" : `Appstle rejected billing attempt: ${billingRes.error}`,
          attemptNumber,
          attemptType: "card_rotation",
          succeeded: false, // Actual result comes via webhook — this is just "attempt submitted"
        });

        console.log(`[Dunning] Billing attempt ${attemptId} for ${shopify_contract_id} card ${card.last4}: ${billingRes.success ? "accepted" : "rejected"} by Appstle${billingRes.error ? ` (${billingRes.error})` : ""}`);

        // Track tried card in DB (survives function restarts)
        // last_attempted_last4 is how the billing-failure webhook identifies which card just failed
        // (Appstle's webhook payload never includes last4).
        const updatedTried = [...dbCardsTried, card.dedupeKey];
        await updateDunningCycle(cycleCheck.id, {
          cards_tried: updatedTried,
          billing_attempt_id: attemptId,
          last_attempted_last4: card.last4,
          next_retry_at: null, // Clear — we just attempted
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
      await step.run("reset-date-rotation", () => resetBillingDateAfterDunning(workspace_id, shopify_contract_id, cycle.id, true));
      return { status: "recovered", method: "card_rotation", cycle_id: cycle.id };
    }

    // Check if all cards returned terminal errors — cancel immediately, no payday retries
    const finalTerminalCards = (postRotationCheck.terminal_cards as string[]) || [];
    const allCardsTerminal = paymentMethods.length > 0 && paymentMethods.every(m => finalTerminalCards.includes(m.last4));

    if (allCardsTerminal) {
      await step.run("all-cards-terminal-cancel", async () => {
        await updateDunningCycle(cycle.id, {
          status: "exhausted",
          terminal_error_code: error_code || "all_cards_terminal",
        });

        await appstleSubscriptionAction(
          workspace_id, shopify_contract_id, "cancel", "dunning",
          `Cancelled by ShopCX — all ${paymentMethods.length} payment methods returned terminal errors`
        );

        await appstleSendPaymentUpdateEmail(workspace_id, shopify_contract_id).catch(() => {});

        const admin = createAdminClient();
        const { data: customer } = await admin.from("customers").select("email, first_name").eq("id", customer_id).single();
        const { data: ws } = await admin.from("workspaces").select("name, portal_config").eq("id", workspace_id).single();
        const portalGeneral = (ws?.portal_config as Record<string, unknown>)?.general as Record<string, unknown> | undefined;
        const updateUrl = (portalGeneral?.payment_update_url as string) || "";
        if (customer?.email && ws?.name && updateUrl) {
          await sendDunningPausedEmail({
            workspaceId: workspace_id,
            toEmail: customer.email,
            customerName: customer.first_name,
            workspaceName: ws.name,
            updateUrl,
          });
        }

        await postDunningNote(workspace_id, customer_id, dunningInternalNote(
          `All ${paymentMethods.length} payment methods returned terminal errors (${finalTerminalCards.join(", ")}). Subscription cancelled — will auto-reactivate if customer adds a new payment method.`
        ));
        await tagCustomerTickets(workspace_id, customer_id, "dunning:terminal");
      });

      return { status: "terminal", reason: "all_cards_terminal", terminal_cards: finalTerminalCards, cycle_id: cycle.id };
    }

    // Step 6: All cards exhausted (non-terminal) — skip/pause + send emails
    await step.run("all-cards-exhausted", async () => {
      await handleAllCardsExhausted(workspace_id, shopify_contract_id, customer_id, cycle, settings);
    });

    // Step 7: Schedule payday retry (cron-driven, not sleep-driven)
    // The dunning/payday-cron picks up cycles with status='retrying' and next_retry_at <= now()
    if (settings.dunning_payday_retry_enabled) {
      await step.run("schedule-payday-retry", async () => {
        const paydayDates = getNextPaydayDates(new Date(), 3);
        if (paydayDates.length > 0) {
          const nextRetry = getRetryTime(paydayDates[0]);
          await updateDunningCycle(cycle.id, {
            status: "retrying",
            next_retry_at: nextRetry.toISOString(),
          });
        }
      });

      return { status: "retrying", cycle_id: cycle.id, cycle_number: cycle.cycle_number };
    }

    // No payday retries — mark exhausted
    await step.run("mark-exhausted", async () => {
      await updateDunningCycle(cycle.id, { status: "exhausted" });
      await resetBillingDateAfterDunning(workspace_id, shopify_contract_id, cycle.id, false);
    });

    dispatchSlackNotification(workspace_id, "dunning_failed", {
      customer: { email: "" },
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

    // Step 1b: Also check for dunning-cancelled subs (exhausted = cancelled, including terminal errors)
    const cancelledSubs = await step.run("check-dunning-cancelled", async () => {
      const admin = createAdminClient();
      // Find cancelled subs where the last dunning cycle was exhausted
      // No cycle_number gate — terminal errors cancel on cycle 1
      const { data: exhaustedCycles } = await admin
        .from("dunning_cycles")
        .select("shopify_contract_id, subscription_id, billing_attempt_id")
        .eq("customer_id", customer_id)
        .eq("status", "exhausted");

      if (!exhaustedCycles?.length) return [];

      // Check which ones are actually cancelled
      const results: { contractId: string; subscriptionId: string | null; billingAttemptId: string | null }[] = [];
      for (const dc of exhaustedCycles) {
        if (!dc.subscription_id) continue;
        const { data: sub } = await admin.from("subscriptions")
          .select("status").eq("id", dc.subscription_id).single();
        if (sub?.status === "cancelled") {
          results.push({
            contractId: dc.shopify_contract_id,
            subscriptionId: dc.subscription_id,
            billingAttemptId: dc.billing_attempt_id,
          });
        }
      }
      return results;
    });

    if (activeCycles.length === 0 && cancelledSubs.length === 0) {
      return { status: "no_active_cycles" };
    }

    const results: { contractId: string; recovered: boolean; error?: string }[] = [];

    // Step 2a: Reactivate dunning-cancelled subs
    for (const cancelled of cancelledSubs) {
      const result = await step.run(`reactivate-${cancelled.contractId}`, async () => {
        try {
          // Reactivate the subscription
          await appstleSubscriptionAction(workspace_id, cancelled.contractId, "resume");

          // Switch to new payment method
          if (payment_method_id) {
            await appstleSwitchPaymentMethod(workspace_id, cancelled.contractId, payment_method_id);
          }

          // Attempt billing
          const ordersRes = await appstleGetUpcomingOrders(workspace_id, cancelled.contractId);
          if (!ordersRes.success || !ordersRes.orders?.length) {
            return { contractId: cancelled.contractId, recovered: true, error: "Reactivated but no upcoming orders to bill" };
          }

          const attemptId = ordersRes.orders[0].id;
          const billingRes = await appstleAttemptBilling(workspace_id, attemptId);

          await logPaymentFailure({
            workspaceId: workspace_id,
            customerId: customer_id,
            subscriptionId: cancelled.subscriptionId,
            shopifyContractId: cancelled.contractId,
            billingAttemptId: attemptId,
            paymentMethodId: payment_method_id,
            attemptNumber: 1,
            attemptType: "new_card_retry",
            succeeded: billingRes.success,
          });

          if (billingRes.success) {
            const admin = createAdminClient();
            await admin.from("subscriptions")
              .update({ status: "active", updated_at: new Date().toISOString() })
              .eq("shopify_contract_id", cancelled.contractId);
          }

          return { contractId: cancelled.contractId, recovered: billingRes.success };
        } catch (err) {
          return { contractId: cancelled.contractId, recovered: false, error: String(err) };
        }
      });
      results.push(result);
    }

    // Step 2b: For each active dunning cycle, unskip + switch card + retry
    for (const cycle of activeCycles) {
      const result = await step.run(`recover-${cycle.shopify_contract_id}`, async () => {
        try {
          // Unskip the order if it was skipped or retrying
          if ((cycle.status === "skipped" || cycle.status === "retrying") && cycle.billing_attempt_id) {
            await appstleUnskipOrder(workspace_id, cycle.billing_attempt_id);
          }

          // If subscription was cancelled (dunning exhausted), reactivate
          const admin = createAdminClient();
          const { data: sub } = await admin.from("subscriptions")
            .select("status")
            .eq("workspace_id", workspace_id)
            .eq("shopify_contract_id", cycle.shopify_contract_id)
            .single();

          if (sub?.status === "cancelled") {
            await appstleSubscriptionAction(workspace_id, cycle.shopify_contract_id, "resume");
          } else if (sub?.status === "paused") {
            // Legacy paused subs — resume them too
            await appstleSubscriptionAction(workspace_id, cycle.shopify_contract_id, "resume");
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
            await resetBillingDateAfterDunning(workspace_id, cycle.shopify_contract_id, cycle.id, true);
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
    // Appstle auto-skips on billing failure — don't skip again
    // Just mark our cycle status and continue with payment update email
    await updateDunningCycle(cycle.id, { status: "skipped", skipped_at: new Date().toISOString() });
    await tagCustomerTickets(workspaceId, customerId, "dunning:skipped");
  } else if (action === "pause" || action === "cancel") {
    // Cancel the subscription — cleaner than indefinite pause
    // If customer adds a new payment method later, auto-reactivate via webhook
    await appstleSubscriptionAction(workspaceId, shopifyContractId, "cancel", "dunning", "Cancelled by ShopCX — payment failed after multiple billing cycles");
    await updateDunningCycle(cycle.id, { status: "exhausted", paused_at: new Date().toISOString() });
    await tagCustomerTickets(workspaceId, customerId, "dunning:cancelled");
  }

  // Send payment update email via Appstle (triggers Shopify secure link)
  await appstleSendPaymentUpdateEmail(workspaceId, shopifyContractId);
  await updateDunningCycle(cycle.id, { payment_update_sent: true, payment_update_sent_at: new Date().toISOString() });

  // Get customer + workspace info for our own email
  if (customerId) {
    const { data: customer } = await admin.from("customers").select("email, first_name, shopify_customer_id").eq("id", customerId).single();
    const { data: ws } = await admin.from("workspaces").select("name, portal_config").eq("id", workspaceId).single();
    const portalGeneral = (ws?.portal_config as Record<string, any>)?.general || {};
    const updateUrl = portalGeneral.payment_update_url || "";

    if (customer?.email && ws?.name && updateUrl) {

      if (action === "pause" || action === "cancel") {
        // Subscription cancelled due to payment failure — send update email
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

/**
 * Reset the subscription's next billing date after dunning recovery or exhaustion.
 *
 * On RECOVERY: next date = now + billing interval (order was just placed)
 * On EXHAUSTION: next date = original failure date + billing interval (missed one cycle, stay on schedule)
 */
async function resetBillingDateAfterDunning(
  workspaceId: string,
  shopifyContractId: string,
  cycleId: string,
  recovered: boolean,
) {
  const admin = createAdminClient();

  const { data: cycle } = await admin.from("dunning_cycles")
    .select("original_billing_date")
    .eq("id", cycleId).single();

  const { data: sub } = await admin.from("subscriptions")
    .select("billing_interval, billing_interval_count")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", shopifyContractId).single();

  if (!sub) return;

  const interval = sub.billing_interval || "month";
  const count = sub.billing_interval_count || 1;

  // Calculate the base date
  const baseDate = recovered
    ? new Date() // Recovery: next billing from now
    : new Date(cycle?.original_billing_date || new Date()); // Exhaustion: from original failure date

  // Add one billing interval
  const nextDate = new Date(baseDate);
  if (interval === "week") nextDate.setDate(nextDate.getDate() + 7 * count);
  else if (interval === "month") nextDate.setMonth(nextDate.getMonth() + count);
  else if (interval === "year") nextDate.setFullYear(nextDate.getFullYear() + count);
  else if (interval === "day") nextDate.setDate(nextDate.getDate() + count);

  // Update locally
  await admin.from("subscriptions")
    .update({ next_billing_date: nextDate.toISOString(), updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", shopifyContractId);

  // Update in Appstle via billing date change endpoint
  try {
    const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", workspaceId).single();
    if (ws?.appstle_api_key_encrypted) {
      const { decrypt } = await import("@/lib/crypto");
      const apiKey = decrypt(ws.appstle_api_key_encrypted);
      const dateStr = nextDate.toISOString().split("T")[0]; // YYYY-MM-DD
      await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-date?contractId=${shopifyContractId}&rescheduleFutureOrder=true&nextBillingDate=${encodeURIComponent(dateStr)}`,
        { method: "PUT", headers: { "X-API-Key": apiKey } },
      );
    }
  } catch (err) {
    console.error(`Failed to reset billing date for ${shopifyContractId}:`, err);
  }
}

// ── dunning/payday-retry-cron ──
// Runs hourly, picks up dunning cycles with status='retrying' and next_retry_at <= now()
// Tries all payment methods, then schedules next payday or marks exhausted

export const dunningPaydayRetryCron = inngest.createFunction(
  {
    id: "dunning-payday-retry-cron",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 * * * *" }], // Every hour
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Find cycles ready to retry
    const cycles = await step.run("find-retryable-cycles", async () => {
      const { data } = await admin
        .from("dunning_cycles")
        .select("id, workspace_id, shopify_contract_id, subscription_id, customer_id, cycle_number, cards_tried, billing_attempt_id")
        .eq("status", "retrying")
        .lte("next_retry_at", new Date().toISOString());

      return data || [];
    });

    if (cycles.length === 0) {
      return { status: "no_cycles_to_retry" };
    }

    const results: { contractId: string; outcome: string }[] = [];

    // Process in batches of 20 with 5s delay between batches to avoid rate limits
    for (let batch = 0; batch < cycles.length; batch += 20) {
      if (batch > 0) await step.sleep(`batch-delay-${batch}`, "5s");
      const batchCycles = cycles.slice(batch, batch + 20);

    for (const cycle of batchCycles) {
      const result = await step.run(`retry-${cycle.shopify_contract_id}`, async () => {
        // Skip if sub is no longer active
        if (cycle.subscription_id) {
          const { data: sub } = await admin.from("subscriptions")
            .select("status")
            .eq("id", cycle.subscription_id)
            .single();
          if (!sub || sub.status === "cancelled") {
            await updateDunningCycle(cycle.id, { status: "exhausted", next_retry_at: null });
            return { contractId: cycle.shopify_contract_id, outcome: "sub_cancelled" };
          }
        }

        const settings = await getDunningSettings(cycle.workspace_id);
        if (!settings?.dunning_payday_retry_enabled) {
          await updateDunningCycle(cycle.id, { status: "exhausted", next_retry_at: null });
          return { contractId: cycle.shopify_contract_id, outcome: "payday_disabled" };
        }

        // Get customer's Shopify ID for payment methods
        const { data: customer } = await admin.from("customers")
          .select("shopify_customer_id")
          .eq("id", cycle.customer_id!)
          .single();

        if (!customer?.shopify_customer_id) {
          await updateDunningCycle(cycle.id, { status: "exhausted", next_retry_at: null });
          return { contractId: cycle.shopify_contract_id, outcome: "no_shopify_customer" };
        }

        // Get all payment methods
        let paymentMethods: Awaited<ReturnType<typeof getCustomerPaymentMethods>> = [];
        try {
          const methods = await getCustomerPaymentMethods(cycle.workspace_id, customer.shopify_customer_id);
          paymentMethods = deduplicatePaymentMethods(methods);
        } catch (e) {
          console.error(`[Dunning Payday] Failed to get payment methods for ${cycle.shopify_contract_id}:`, e);
        }

        if (paymentMethods.length === 0) {
          await updateDunningCycle(cycle.id, { status: "exhausted", next_retry_at: null });
          return { contractId: cycle.shopify_contract_id, outcome: "no_payment_methods" };
        }

        // Try each payment method (no sleep — all at once for this cycle)
        let recovered = false;
        for (const card of paymentMethods) {
          // Check if already recovered (billing-success webhook may fire)
          const check = await getActiveDunningCycle(cycle.workspace_id, cycle.shopify_contract_id);
          if (!check || check.status === "recovered") { recovered = true; break; }

          try {
            await appstleSwitchPaymentMethod(cycle.workspace_id, cycle.shopify_contract_id, card.id);

            const ordersRes = await appstleGetUpcomingOrders(cycle.workspace_id, cycle.shopify_contract_id);
            if (!ordersRes.success || !ordersRes.orders?.length) continue;

            const attemptId = ordersRes.orders[0].id;
            await appstleAttemptBilling(cycle.workspace_id, attemptId);

            await logPaymentFailure({
              workspaceId: cycle.workspace_id,
              customerId: cycle.customer_id,
              subscriptionId: cycle.subscription_id,
              shopifyContractId: cycle.shopify_contract_id,
              billingAttemptId: attemptId,
              paymentMethodLast4: card.last4,
              paymentMethodId: card.id,
              attemptNumber: 0,
              attemptType: "payday_retry",
              succeeded: false,
            });

            await updateDunningCycle(cycle.id, { billing_attempt_id: attemptId, last_attempted_last4: card.last4 });
          } catch (e) {
            console.error(`[Dunning Payday] Card ${card.last4} failed for ${cycle.shopify_contract_id}:`, e);
          }
        }

        // Check final state
        const finalCheck = await getActiveDunningCycle(cycle.workspace_id, cycle.shopify_contract_id);
        if (!finalCheck || finalCheck.status === "recovered") {
          await resetBillingDateAfterDunning(cycle.workspace_id, cycle.shopify_contract_id, cycle.id, true);
          return { contractId: cycle.shopify_contract_id, outcome: "recovered" };
        }

        // Schedule next payday retry or mark exhausted
        const paydayDates = getNextPaydayDates(new Date(), 3);
        // Find next payday that's in the future
        const futurePaydays = paydayDates.filter(d => d.getTime() > Date.now() + 60 * 60 * 1000); // at least 1h from now

        if (futurePaydays.length > 0) {
          const nextRetry = getRetryTime(futurePaydays[0]);
          await updateDunningCycle(cycle.id, { next_retry_at: nextRetry.toISOString() });
          return { contractId: cycle.shopify_contract_id, outcome: "scheduled_next_payday" };
        }

        // No more paydays — exhausted. Send final payment update email.
        await updateDunningCycle(cycle.id, { status: "exhausted", next_retry_at: null });
        await resetBillingDateAfterDunning(cycle.workspace_id, cycle.shopify_contract_id, cycle.id, false);

        // Send payment update email
        if (cycle.customer_id) {
          const { data: cust } = await admin.from("customers")
            .select("email, first_name").eq("id", cycle.customer_id).single();
          const { data: ws } = await admin.from("workspaces")
            .select("name, portal_config").eq("id", cycle.workspace_id).single();
          const portalGeneral = (ws?.portal_config as Record<string, unknown>)?.general as Record<string, string> | undefined;
          const updateUrl = portalGeneral?.payment_update_url || "";

          if (cust?.email && ws?.name && updateUrl) {
            await sendDunningPaymentUpdateEmail({
              workspaceId: cycle.workspace_id,
              toEmail: cust.email,
              customerName: cust.first_name,
              workspaceName: ws.name,
              updateUrl,
            });
          }

          await postDunningNote(cycle.workspace_id, cycle.customer_id, dunningInternalNote(
            `All payday retries exhausted for subscription ${cycle.shopify_contract_id}. Payment update email sent.`
          ));
        }

        dispatchSlackNotification(cycle.workspace_id, "dunning_failed", {
          customer: { email: "" },
          attempts: cycle.cycle_number || 0,
        }).catch(() => {});

        return { contractId: cycle.shopify_contract_id, outcome: "exhausted" };
      });

      results.push(result);
    }
    } // end batch loop

    return { processed: results.length, results };
  }
);
