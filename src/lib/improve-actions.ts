/**
 * Improve-tab action dispatcher. Used by both:
 *   - The Opus loop in /api/tickets/[id]/improve (when admin hasn't yet
 *     approved a proposal)
 *   - The fast-path "execute_actions" body field (when admin clicks
 *     Approve & Execute — bypasses Opus to avoid the "Opus forgot the
 *     JSON it emitted last turn" failure mode)
 *
 * Returns the result strings + the action context (label_url, etc.)
 * accumulated across the batch so chained send_message can substitute
 * placeholders.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface ImproveAction {
  type: string;
  [key: string]: unknown;
}

export interface ImproveActionResult {
  results: string[];
  actionContext: Record<string, string>;
}

const ctaButton = (url: string, label: string): string =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 16px 0;"><tr><td bgcolor="#0f766e" style="background-color:#0f766e;border-radius:8px;"><a href="${url}" style="display:inline-block;padding:14px 24px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">${label}</a></td></tr></table>`;

export async function runImproveActions(
  workspaceId: string,
  ticketId: string,
  actions: ImproveAction[],
): Promise<ImproveActionResult> {
  const admin = createAdminClient();
  const results: string[] = [];
  const actionContext: Record<string, string> = {};

  for (const action of actions) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = action as any;
      switch (action.type) {
        case "partial_refund": {
          const { partialRefundByAmount } = await import("@/lib/shopify-order-actions");
          const r = await partialRefundByAmount(workspaceId, a.shopify_order_id, a.amount_cents, a.reason);
          results.push(r.success ? `Refund of $${(a.amount_cents / 100).toFixed(2)} issued` : `Refund failed: ${r.error}`);
          if (r.success) actionContext.refund_amount = `$${(a.amount_cents / 100).toFixed(2)}`;
          break;
        }
        case "create_return": {
          // Use the canonical createFullReturn helper so we (a) persist a
          // `returns` row for audit + downstream UI, and (b) avoid the
          // `is_return: true` shipment flag — for USPS, that flag tells
          // EasyPost to print the label with FROM/TO swapped, so USPS
          // then delivers the package back to the customer instead of to
          // our warehouse (Janet Kellie, ticket 8aabc12f). The non-flag
          // path matches what the Sonnet orchestrator already uses.
          const { createFullReturn } = await import("@/lib/shopify-returns");
          const { data: order } = await admin.from("orders")
            .select("id, order_number, shopify_order_id, shipping_address")
            .or(`shopify_order_id.eq.${a.shopify_order_id},order_number.eq.${a.shopify_order_id}`)
            .single();
          if (!order) { results.push(`create_return: order not found (${a.shopify_order_id})`); break; }

          const { data: t } = await admin.from("tickets").select("customer_id").eq("id", ticketId).single();
          if (!t?.customer_id) { results.push(`create_return: no customer on ticket`); break; }

          const { data: customer } = await admin.from("customers")
            .select("first_name, last_name, phone").eq("id", t.customer_id).single();
          const ship = order.shipping_address as Record<string, string> | null;
          if (!ship?.address1) { results.push(`create_return: order has no shipping address`); break; }

          const r = await createFullReturn({
            workspaceId,
            orderId: order.id,
            orderNumber: order.order_number,
            shopifyOrderGid: `gid://shopify/Order/${order.shopify_order_id}`,
            customerId: t.customer_id,
            ticketId,
            customerName: ship.name || `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || "Customer",
            customerPhone: ship.phone || customer?.phone || undefined,
            shippingAddress: {
              street1: ship.address1,
              city: ship.city || "",
              state: ship.province_code || ship.provinceCode || ship.state || "",
              zip: ship.zip || "",
              country: ship.country_code || ship.countryCode || "US",
            },
            source: "agent",
            freeLabel: !!a.free_label,
          });

          if (!r.success || !r.labelUrl) {
            results.push(`create_return: ${r.error || "failed"}`);
            break;
          }
          actionContext.label_url = r.labelUrl;
          actionContext.tracking_number = r.trackingNumber || "";
          actionContext.carrier = r.carrier || "USPS";
          const cost = ((r.labelCostCents || 0) / 100).toFixed(2);
          results.push(`Return label created (${order.order_number}) — tracking ${r.trackingNumber}, $${cost}`);
          break;
        }
        case "swap_variant": {
          const { subSwapVariant } = await import("@/lib/subscription-items");
          const r = await subSwapVariant(workspaceId, a.contract_id, a.old_variant_id, a.new_variant_id, a.quantity || 1);
          results.push(r.success ? `Variant swapped (${a.old_variant_id} → ${a.new_variant_id})` : `Swap failed: ${r.error}`);
          break;
        }
        case "change_next_date": {
          const { appstleUpdateNextBillingDate } = await import("@/lib/appstle");
          const r = await appstleUpdateNextBillingDate(workspaceId, a.contract_id, a.date);
          results.push(r.success ? `Next billing date set to ${a.date}` : `Date change failed: ${r.error}`);
          break;
        }
        case "change_frequency": {
          const { appstleUpdateBillingInterval } = await import("@/lib/appstle");
          const r = await appstleUpdateBillingInterval(workspaceId, a.contract_id, a.interval, Number(a.interval_count));
          results.push(r.success ? `Frequency: every ${a.interval_count} ${a.interval}` : `Frequency failed: ${r.error}`);
          break;
        }
        case "update_shipping_address": {
          const { executeSonnetDecision } = await import("@/lib/action-executor");
          const { data: t } = await admin.from("tickets").select("customer_id, channel").eq("id", ticketId).single();
          if (!t?.customer_id) { results.push(`update_shipping_address: no customer on ticket`); break; }
          await executeSonnetDecision(
            { admin, workspaceId, ticketId, customerId: t.customer_id, channel: t.channel || "email", sandbox: false },
            {
              reasoning: "Admin improve: update shipping address",
              action_type: "direct_action",
              actions: [{ type: "update_shipping_address", contract_id: a.contract_id, address: a.address }],
            },
            null,
            async () => { /* no customer-facing message — admin's send_message handles it */ },
            async (m) => {
              await admin.from("ticket_messages").insert({
                ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system", body: m,
              });
            },
          );
          results.push(`Shipping address updated`);
          break;
        }
        case "propose_sonnet_prompt": {
          const { data: ins, error } = await admin.from("sonnet_prompts").insert({
            workspace_id: workspaceId,
            title: a.title,
            content: a.content,
            category: a.category || "rule",
            enabled: false,
            status: "proposed",
            derived_from_ticket_id: ticketId,
            proposed_at: new Date().toISOString(),
            sort_order: 200,
          }).select("id").single();
          if (error) { results.push(`propose_sonnet_prompt failed: ${error.message}`); break; }
          results.push(`Proposed sonnet_prompt rule "${a.title}" — review at /dashboard/settings/ai/prompts (id ${ins.id})`);
          break;
        }
        case "propose_grader_rule": {
          const { data: ins, error } = await admin.from("grader_prompts").insert({
            workspace_id: workspaceId,
            title: a.title,
            content: a.content,
            status: "proposed",
            derived_from_ticket_id: ticketId,
          }).select("id").single();
          if (error) { results.push(`propose_grader_rule failed: ${error.message}`); break; }
          results.push(`Proposed grader rule "${a.title}" — review at /dashboard/settings/ai/grader-rules (id ${ins.id})`);
          break;
        }
        case "send_message": {
          let body = String(a.body || "");
          if (actionContext.label_url) {
            const button = ctaButton(actionContext.label_url, "Download your prepaid return label →");
            body = body.replace(/\{\{\s*label_url\s*\}\}/g, button)
                       .replace(/\[\s*LABEL_URL\s*\]/g, button);
          }
          for (const [key, val] of Object.entries(actionContext)) {
            if (key === "label_url") continue;
            const lower = `{{\\s*${key}\\s*}}`;
            const upper = `\\[\\s*${key.toUpperCase()}\\s*\\]`;
            body = body.replace(new RegExp(lower, "g"), val);
            body = body.replace(new RegExp(upper, "g"), val);
          }

          const { data: wsInfo } = await admin.from("workspaces").select("name, sandbox_mode").eq("id", workspaceId).single();
          const { data: t } = await admin.from("tickets").select("channel, customer_id, subject, email_message_id").eq("id", ticketId).single();
          await admin.from("ticket_messages").insert({
            ticket_id: ticketId, direction: "outbound", visibility: "external",
            author_type: "system", body, sent_at: new Date().toISOString(),
          });
          if (t?.channel === "email" && t.customer_id) {
            const { data: cust2 } = await admin.from("customers").select("email").eq("id", t.customer_id).single();
            if (cust2?.email && !wsInfo?.sandbox_mode) {
              const { sendTicketReply } = await import("@/lib/email");
              await sendTicketReply({ workspaceId, toEmail: cust2.email, subject: `Re: ${t.subject || "Your request"}`, body, inReplyTo: t.email_message_id, agentName: "Support", workspaceName: wsInfo?.name || "" });
            }
          }
          results.push("Message sent to customer");
          break;
        }
        case "reactivate": {
          const { appstleSubscriptionAction } = await import("@/lib/appstle");
          const r = await appstleSubscriptionAction(workspaceId, a.contract_id, "resume");
          results.push(r.success ? "Subscription reactivated" : `Reactivation failed: ${r.error}`);
          break;
        }
        case "update_line_item_price": {
          const { subUpdateLineItemPrice } = await import("@/lib/subscription-items");
          const r = await subUpdateLineItemPrice(workspaceId, a.contract_id, a.variant_id || "", a.base_price_cents);
          results.push(r.success ? `Base price updated to $${(a.base_price_cents / 100).toFixed(2)}` : `Price update failed: ${r.error}`);
          break;
        }
        case "apply_coupon": {
          const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
          const { getAppstleConfig } = await import("@/lib/subscription-items");
          const config = await getAppstleConfig(workspaceId);
          if (config) {
            const r = await applyDiscountWithReplace(config.apiKey, a.contract_id, a.code);
            results.push(r.success ? `Coupon ${a.code} applied` : `Coupon failed: ${r.error}`);
          } else results.push("Appstle not configured");
          break;
        }
        case "skip_next_order": {
          const { appstleSkipNextOrder } = await import("@/lib/appstle");
          const r = await appstleSkipNextOrder(workspaceId, a.contract_id);
          results.push(r.success ? "Next order skipped" : `Skip failed: ${r.error}`);
          break;
        }
        case "crisis_pause": {
          const { appstleSubscriptionAction } = await import("@/lib/appstle");
          const r = await appstleSubscriptionAction(workspaceId, a.contract_id, "pause", "Crisis pause via admin improve");
          results.push(r.success ? "Subscription paused (crisis)" : `Pause failed: ${r.error}`);
          break;
        }
        case "pause_timed": {
          // Timed pause — pauses now and schedules auto-resume in N days.
          // Reuses the conversation orchestrator's pause_timed handler so
          // the same Appstle + scheduling machinery runs.
          const { executeSonnetDecision } = await import("@/lib/action-executor");
          const { data: t } = await admin.from("tickets").select("customer_id, channel").eq("id", ticketId).single();
          if (!t?.customer_id) { results.push(`pause_timed: no customer on ticket`); break; }
          await executeSonnetDecision(
            { admin, workspaceId, ticketId, customerId: t.customer_id, channel: t.channel || "email", sandbox: false },
            {
              reasoning: "Admin improve: timed pause",
              action_type: "direct_action",
              actions: [{ type: "pause_timed", contract_id: a.contract_id, pause_days: a.pause_days || 30 }],
            },
            null,
            async () => { /* no customer-facing message — admin's send_message handles it */ },
            async (m) => {
              await admin.from("ticket_messages").insert({
                ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system", body: m,
              });
            },
          );
          results.push(`Subscription paused for ${a.pause_days || 30} days (${a.contract_id})`);
          break;
        }
        case "pause": {
          // Indefinite pause (no auto-resume). Use pause_timed when you
          // want a specific resume date.
          const { appstleSubscriptionAction } = await import("@/lib/appstle");
          const r = await appstleSubscriptionAction(workspaceId, a.contract_id, "pause");
          results.push(r.success ? "Subscription paused" : `Pause failed: ${r.error}`);
          break;
        }
        case "cancel": {
          const { appstleSubscriptionAction } = await import("@/lib/appstle");
          const r = await appstleSubscriptionAction(workspaceId, a.contract_id, "cancel", a.reason);
          results.push(r.success ? "Subscription cancelled" : `Cancel failed: ${r.error}`);
          break;
        }
        case "close_ticket": {
          await admin.from("tickets").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", ticketId);
          results.push("Ticket closed");
          break;
        }
        case "reopen_ticket": {
          await admin.from("tickets").update({ status: "open" }).eq("id", ticketId);
          results.push("Ticket reopened");
          break;
        }
        default:
          results.push(`Unknown action: ${action.type}`);
      }
    } catch (err) {
      results.push(`Action ${action.type} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Log all results as a single internal note
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system",
    body: `[Admin Improve] Actions executed:\n${results.map(r => `• ${r}`).join("\n")}`,
  });

  return { results, actionContext };
}
