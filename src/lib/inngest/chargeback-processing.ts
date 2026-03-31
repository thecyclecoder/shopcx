import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { appstleSubscriptionAction } from "@/lib/appstle";
import { unsubscribeFromAllMarketing } from "@/lib/shopify-marketing";
import { dispatchSlackNotification } from "@/lib/slack-notify";

// ── chargeback/received — main processing pipeline ──

export const chargebackReceived = inngest.createFunction(
  {
    id: "chargeback-received",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.chargebackEventId" }],
    triggers: [{ event: "chargeback/received" }],
  },
  async ({ event, step }) => {
    const { chargebackEventId, workspaceId } = event.data as {
      chargebackEventId: string;
      workspaceId: string;
    };
    const admin = createAdminClient();

    // Step 1: Load chargeback event + workspace settings
    const ctx = await step.run("load-context", async () => {
      const { data: cb } = await admin
        .from("chargeback_events")
        .select("*")
        .eq("id", chargebackEventId)
        .single();

      const { data: ws } = await admin
        .from("workspaces")
        .select("id, chargeback_auto_cancel, chargeback_notify, chargeback_auto_ticket, chargeback_auto_cancel_reasons")
        .eq("id", workspaceId)
        .single();

      return { cb, ws };
    });

    if (!ctx.cb || !ctx.ws) return;
    const cb = ctx.cb;
    const ws = ctx.ws;

    // Step 2: Resolve customer from order
    const customerId = await step.run("resolve-customer", async () => {
      if (cb.customer_id) return cb.customer_id;
      if (!cb.shopify_order_id) return null;

      // Look up order to find customer
      const { data: order } = await admin
        .from("orders")
        .select("customer_id, shopify_customer_id, email")
        .eq("workspace_id", workspaceId)
        .eq("shopify_order_id", cb.shopify_order_id)
        .maybeSingle();

      if (order?.customer_id) {
        await admin
          .from("chargeback_events")
          .update({ customer_id: order.customer_id })
          .eq("id", chargebackEventId);
        return order.customer_id;
      }

      // Try email lookup
      if (order?.email) {
        const { data: cust } = await admin
          .from("customers")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("email", order.email)
          .maybeSingle();

        if (cust) {
          await admin
            .from("chargeback_events")
            .update({ customer_id: cust.id })
            .eq("id", chargebackEventId);
          return cust.id;
        }
      }

      return null;
    });

    if (!customerId) {
      // Can't proceed without customer — notify for manual review
      if (ws.chargeback_notify) {
        await step.run("notify-no-customer", async () => {
          await admin.from("dashboard_notifications").insert({
            workspace_id: workspaceId,
            type: "chargeback_alert",
            title: "Chargeback — Customer not found",
            body: `A ${cb.dispute_type} was filed on order ${cb.shopify_order_id || "unknown"} but the customer could not be resolved. Manual review required.`,
            link: `/dashboard/chargebacks`,
            metadata: { entity_id: chargebackEventId, entity_type: "chargeback_event" },
          });
        });
      }
      return;
    }

    // Step 3: Classify and route
    const route = await step.run("classify-and-route", async () => {
      // Inquiry = never auto-cancel
      if (cb.dispute_type === "inquiry") {
        return "review" as const;
      }

      // Check if this reason is configured for auto-cancel
      const autoReasons: string[] = ws.chargeback_auto_cancel_reasons || [];
      if (ws.chargeback_auto_cancel && cb.reason && autoReasons.includes(cb.reason)) {
        return "auto_cancel" as const;
      }

      return "review" as const;
    });

    // Step 3b: Unsubscribe from all marketing — don't market to chargeback filers
    await step.run("unsubscribe-marketing", async () => {
      await unsubscribeFromAllMarketing(workspaceId, customerId);
    });

    // Step 4: Execute action
    if (route === "auto_cancel") {
      const cancelResult = await step.run("auto-cancel-subscriptions", async () => {
        // Idempotency check
        const { data: freshCb } = await admin
          .from("chargeback_events")
          .select("auto_action_taken")
          .eq("id", chargebackEventId)
          .single();

        if (freshCb?.auto_action_taken) {
          return { skipped: true, cancelled: 0 };
        }

        // Get active subscriptions for this customer
        const { data: subs } = await admin
          .from("subscriptions")
          .select("id, shopify_contract_id")
          .eq("customer_id", customerId)
          .eq("workspace_id", workspaceId)
          .in("status", ["active", "paused"]);

        if (!subs || subs.length === 0) {
          await admin
            .from("chargeback_events")
            .update({ auto_action_taken: "none", auto_action_at: new Date().toISOString() })
            .eq("id", chargebackEventId);
          return { skipped: false, cancelled: 0 };
        }

        let cancelledCount = 0;
        const failedIds: string[] = [];

        for (const sub of subs) {
          if (!sub.shopify_contract_id) continue;

          const result = await appstleSubscriptionAction(
            workspaceId,
            sub.shopify_contract_id,
            "cancel",
            "chargeback"
          );

          if (result.success) {
            cancelledCount++;
            // Log the action
            await admin.from("chargeback_subscription_actions").insert({
              chargeback_event_id: chargebackEventId,
              subscription_id: sub.id,
              customer_id: customerId,
              workspace_id: workspaceId,
              action: "cancelled",
              cancellation_reason: "chargeback_fraud",
              executed_by: "system_auto",
            });
          } else {
            failedIds.push(sub.id);
            console.error(`Failed to cancel subscription ${sub.id}:`, result.error);
          }
        }

        // Only mark as complete if ALL subscriptions were cancelled
        if (failedIds.length === 0) {
          await admin
            .from("chargeback_events")
            .update({
              auto_action_taken: "subscriptions_cancelled",
              auto_action_at: new Date().toISOString(),
            })
            .eq("id", chargebackEventId);
        } else {
          // Partial failure — flag for review
          await admin
            .from("chargeback_events")
            .update({ auto_action_taken: "flagged_for_review", auto_action_at: new Date().toISOString() })
            .eq("id", chargebackEventId);
        }

        return { skipped: false, cancelled: cancelledCount, failed: failedIds.length };
      });

      if (cancelResult.skipped) return;
    } else {
      // Review path — flag for manual review
      await step.run("flag-for-review", async () => {
        await admin
          .from("chargeback_events")
          .update({ auto_action_taken: "flagged_for_review", auto_action_at: new Date().toISOString() })
          .eq("id", chargebackEventId);
      });
    }

    // Chargebacks no longer create fraud cases — fraud cases come only from
    // actual fraud rules (shared_address, high_velocity, etc.) in Settings → Fraud.
    // Chargebacks are tracked in the Chargebacks system instead.
    const fraudCaseId: string | null = null;

    // Step 6: Create ticket + notifications
    await step.run("notify-and-ticket", async () => {
      const { data: order } = cb.shopify_order_id
        ? await admin
            .from("orders")
            .select("order_number")
            .eq("workspace_id", workspaceId)
            .eq("shopify_order_id", cb.shopify_order_id)
            .maybeSingle()
        : { data: null };

      const orderLabel = order?.order_number || cb.shopify_order_id || "Unknown";
      const amountStr = cb.amount_cents ? `$${(cb.amount_cents / 100).toFixed(2)}` : "Unknown";
      const evidenceStr = cb.evidence_due_by
        ? new Date(cb.evidence_due_by).toLocaleDateString()
        : "N/A";

      // Fresh read to see what action was taken
      const { data: freshCb } = await admin
        .from("chargeback_events")
        .select("auto_action_taken")
        .eq("id", chargebackEventId)
        .single();

      const actionTaken = freshCb?.auto_action_taken;

      // Dashboard notification
      if (ws.chargeback_notify) {
        const isAutoCancel = actionTaken === "subscriptions_cancelled";
        await admin.from("dashboard_notifications").insert({
          workspace_id: workspaceId,
          type: "chargeback_alert",
          title: `Chargeback — ${cb.reason || "unknown"} — ${amountStr}`,
          body: isAutoCancel
            ? `Subscriptions automatically cancelled. Evidence due ${evidenceStr}. Order ${orderLabel}.`
            : cb.dispute_type === "inquiry"
              ? `Payment inquiry filed on order ${orderLabel}. Reason: ${cb.reason}. No action taken yet. Evidence due ${evidenceStr}.`
              : `Manual review required. Evidence due ${evidenceStr}. Order ${orderLabel}.`,
          link: `/dashboard/chargebacks`,
          metadata: {
            entity_id: chargebackEventId,
            entity_type: "chargeback_event",
            fraud_case_id: fraudCaseId,
          },
        });
      }

      // Slack notification
      dispatchSlackNotification(workspaceId, "chargeback", {
        customer: { email: cb.email || "" },
        amount: amountStr,
        reason: cb.reason || "unknown",
        orderId: orderLabel,
      }).catch(() => {});

      // Support ticket
      if (ws.chargeback_auto_ticket) {
        const { data: ticket } = await admin
          .from("tickets")
          .insert({
            workspace_id: workspaceId,
            customer_id: customerId,
            channel: "email",
            status: "open",
            subject: `Chargeback — ${cb.reason || "unknown"} — Order ${orderLabel}`,
            tags: ["smart:billing", "chargeback"],
          })
          .select("id")
          .single();

        if (ticket) {
          // Link ticket to chargeback event
          await admin
            .from("chargeback_events")
            .update({ ticket_id: ticket.id })
            .eq("id", chargebackEventId);

          // Internal note with details
          const noteLines = [
            `**Chargeback Details**`,
            `- Dispute ID: ${cb.shopify_dispute_id}`,
            `- Order: ${orderLabel}`,
            `- Amount: ${amountStr} ${cb.currency}`,
            `- Reason: ${cb.reason || "N/A"}`,
            `- Type: ${cb.dispute_type}`,
            `- Evidence due: ${evidenceStr}`,
            `- Auto-action: ${actionTaken || "pending"}`,
          ];

          if (cb.dispute_type === "inquiry") {
            noteLines.push("", "This is an inquiry, not a confirmed chargeback. Do NOT cancel subscriptions.");
          } else if (actionTaken === "subscriptions_cancelled") {
            noteLines.push("", "Subscriptions were automatically cancelled due to fraud/unrecognized reason.");
          } else {
            noteLines.push("", "Flagged for review. This chargeback reason may be winnable. Review and respond within 24 hours.");
          }

          if (fraudCaseId) {
            noteLines.push("", `Fraud case: /dashboard/fraud?case=${fraudCaseId}`);
          }

          await admin.from("ticket_messages").insert({
            ticket_id: ticket.id,
            direction: "internal",
            visibility: "internal",
            author_type: "system",
            body: noteLines.join("\n"),
          });
        }
      }
    });
  }
);

// ── chargeback/won ──

export const chargebackWon = inngest.createFunction(
  {
    id: "chargeback-won",
    retries: 2,
    triggers: [{ event: "chargeback/won" }],
  },
  async ({ event, step }) => {
    const { chargebackEventId, workspaceId } = event.data as {
      chargebackEventId: string;
      workspaceId: string;
    };
    const admin = createAdminClient();

    await step.run("process-win", async () => {
      const { data: cb } = await admin
        .from("chargeback_events")
        .select("*, ticket_id, fraud_case_id, auto_action_taken, amount_cents, shopify_order_id")
        .eq("id", chargebackEventId)
        .single();

      if (!cb) return;

      const amountStr = cb.amount_cents ? `$${(cb.amount_cents / 100).toFixed(2)}` : "Unknown";

      // Look up order number
      const { data: order } = cb.shopify_order_id
        ? await admin
            .from("orders")
            .select("order_number")
            .eq("workspace_id", workspaceId)
            .eq("shopify_order_id", cb.shopify_order_id)
            .maybeSingle()
        : { data: null };

      const orderLabel = order?.order_number || cb.shopify_order_id || "Unknown";

      // Add internal note to linked ticket
      if (cb.ticket_id) {
        await admin.from("ticket_messages").insert({
          ticket_id: cb.ticket_id,
          direction: "internal",
          visibility: "internal",
          author_type: "system",
          body: `Chargeback **WON**. Funds returned. Amount: ${amountStr}.`,
        });
      }

      // Update fraud case if exists
      if (cb.fraud_case_id) {
        await admin
          .from("fraud_cases")
          .update({ status: "dismissed", resolution: "chargeback_won", dismissal_reason: "Chargeback won — funds returned" })
          .eq("id", cb.fraud_case_id);
      }

      // Notification
      const body = cb.auto_action_taken === "subscriptions_cancelled"
        ? `Chargeback WON on Order ${orderLabel}. Subscriptions were previously cancelled — consider reaching out to reinstate.`
        : `Chargeback WON on Order ${orderLabel}. Amount ${amountStr} returned.`;

      await admin.from("dashboard_notifications").insert({
        workspace_id: workspaceId,
        type: "chargeback_alert",
        title: `Chargeback WON — ${amountStr}`,
        body,
        link: `/dashboard/chargebacks`,
        metadata: { entity_id: chargebackEventId, entity_type: "chargeback_event" },
      });
    });
  }
);

// ── chargeback/lost ──

export const chargebackLost = inngest.createFunction(
  {
    id: "chargeback-lost",
    retries: 2,
    triggers: [{ event: "chargeback/lost" }],
  },
  async ({ event, step }) => {
    const { chargebackEventId, workspaceId } = event.data as {
      chargebackEventId: string;
      workspaceId: string;
    };
    const admin = createAdminClient();

    await step.run("process-loss", async () => {
      const { data: cb } = await admin
        .from("chargeback_events")
        .select("*, ticket_id, fraud_case_id, amount_cents, reason, shopify_order_id")
        .eq("id", chargebackEventId)
        .single();

      if (!cb) return;

      const amountStr = cb.amount_cents ? `$${(cb.amount_cents / 100).toFixed(2)}` : "Unknown";

      // Add internal note to linked ticket
      if (cb.ticket_id) {
        await admin.from("ticket_messages").insert({
          ticket_id: cb.ticket_id,
          direction: "internal",
          visibility: "internal",
          author_type: "system",
          body: `Chargeback **LOST**. Amount of ${amountStr} returned to cardholder.`,
        });
      }

      // Update fraud case
      if (cb.fraud_case_id && cb.reason === "fraudulent") {
        await admin
          .from("fraud_cases")
          .update({ status: "confirmed_fraud", resolution: "chargeback_lost" })
          .eq("id", cb.fraud_case_id);
      }

      await admin.from("dashboard_notifications").insert({
        workspace_id: workspaceId,
        type: "chargeback_alert",
        title: `Chargeback LOST — ${amountStr}`,
        body: `Chargeback lost on order ${cb.shopify_order_id || "unknown"}. Amount of ${amountStr} returned to cardholder.`,
        link: `/dashboard/chargebacks`,
        metadata: { entity_id: chargebackEventId, entity_type: "chargeback_event" },
      });
    });
  }
);

// ── Nightly evidence reminder cron ──

export const chargebackEvidenceReminder = inngest.createFunction(
  {
    id: "chargeback-evidence-reminder",
    retries: 2,
    triggers: [{ cron: "0 9 * * *" }], // 9am UTC daily
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaces = await step.run("load-workspaces", async () => {
      const { data } = await admin
        .from("workspaces")
        .select("id, chargeback_evidence_reminder, chargeback_evidence_reminder_days")
        .eq("chargeback_evidence_reminder", true);
      return data || [];
    });

    for (const ws of workspaces) {
      await step.run(`remind-${ws.id}`, async () => {
        const reminderDays = ws.chargeback_evidence_reminder_days || 3;

        const { data: chargebacks } = await admin
          .from("chargeback_events")
          .select("id, shopify_order_id, reason, amount_cents, evidence_due_by")
          .eq("workspace_id", ws.id)
          .eq("status", "under_review")
          .is("evidence_sent_on", null)
          .lte("evidence_due_by", new Date(Date.now() + reminderDays * 86400000).toISOString())
          .gte("evidence_due_by", new Date().toISOString());

        if (!chargebacks || chargebacks.length === 0) return;

        for (const cb of chargebacks) {
          // Don't duplicate today's notification
          const today = new Date().toISOString().split("T")[0];
          const { data: existing } = await admin
            .from("dashboard_notifications")
            .select("id")
            .eq("workspace_id", ws.id)
            .eq("type", "chargeback_alert")
            .eq("metadata->>entity_id", cb.id)
            .gte("created_at", today)
            .maybeSingle();

          if (existing) continue;

          const dueDate = new Date(cb.evidence_due_by!);
          const daysLeft = Math.ceil((dueDate.getTime() - Date.now()) / 86400000);
          const amountStr = cb.amount_cents ? `$${(cb.amount_cents / 100).toFixed(2)}` : "Unknown";

          await admin.from("dashboard_notifications").insert({
            workspace_id: ws.id,
            type: "chargeback_alert",
            title: `Chargeback evidence due in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
            body: `Order ${cb.shopify_order_id || "unknown"} — ${cb.reason} — ${amountStr}. Submit evidence before ${dueDate.toLocaleDateString()}.`,
            link: `/dashboard/chargebacks`,
            metadata: { entity_id: cb.id, entity_type: "chargeback_event" },
          });
        }
      });
    }
  }
);
