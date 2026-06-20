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
import type { ActionContext, ActionParams, ActionResult } from "@/lib/action-executor";

type Admin = ReturnType<typeof createAdminClient>;

export interface ImproveAction {
  type: string;
  [key: string]: unknown;
}

export interface ImproveActionResult {
  results: string[];
  actionContext: Record<string, string>;
}

/**
 * Dispatch ONE direct action through the orchestrator's directActionHandlers
 * registry — the SAME code path handleDirectAction uses in production. This is
 * how the Improve tab and the orchestrator share a single customer-action path
 * (no drift): the Appstle / Shopify / loyalty execution lives only in
 * action-executor.ts. Mirrors the UUID→contract resolution + per-action call
 * logging the orchestrator does. See docs/brain/specs/improve-orchestrator-action-parity.md.
 */
async function dispatchDirectAction(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
  type: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const { data: t } = await admin.from("tickets").select("customer_id, channel").eq("id", ticketId).single();
  if (!t?.customer_id) return { success: false, error: "no customer on ticket" };

  const { directActionHandlers } = await import("@/lib/action-executor");
  const { withActionContext } = await import("@/lib/appstle-call-log");
  const handler = directActionHandlers[type];
  if (!handler) return { success: false, error: `Unknown action type: ${type}` };

  const ctx: ActionContext = {
    admin, workspaceId, ticketId, customerId: t.customer_id, channel: t.channel || "email", sandbox: false,
  };
  const action = { type, ...params } as ActionParams;
  // Resolve internal subscription UUID → Shopify contract id (mirrors handleDirectAction).
  if (action.contract_id && action.contract_id.includes("-")) {
    const { data: sub } = await admin.from("subscriptions")
      .select("shopify_contract_id").eq("id", action.contract_id).maybeSingle();
    if (sub?.shopify_contract_id) action.contract_id = sub.shopify_contract_id;
  }
  return withActionContext(
    { workspaceId, ticketId, customerId: t.customer_id, actionType: type },
    () => handler(ctx, action),
  );
}

/** Pull customer-facing result fields into actionContext so a chained send_message can substitute them. */
function captureContext(actionContext: Record<string, string>, result: ActionResult): void {
  if (!result.success) return;
  if (result.refundAmountCents != null) actionContext.refund_amount = `$${(result.refundAmountCents / 100).toFixed(2)}`;
  if (result.labelUrl) actionContext.label_url = result.labelUrl;
  if (result.trackingNumber) actionContext.tracking_number = result.trackingNumber;
  if (result.carrier) actionContext.carrier = result.carrier;
  if (result.couponCode) actionContext.coupon_code = result.couponCode;
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
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "partial_refund", {
            shopify_order_id: a.shopify_order_id, amount_cents: a.amount_cents, reason: a.reason,
          });
          captureContext(actionContext, r);
          results.push(r.success ? (r.summary || `Refund of $${(a.amount_cents / 100).toFixed(2)} issued`) : `Refund failed: ${r.error}`);
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
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "swap_variant", {
            contract_id: a.contract_id, old_variant_id: a.old_variant_id, new_variant_id: a.new_variant_id, quantity: a.quantity || 1,
          });
          results.push(r.success ? (r.summary || `Variant swapped (${a.old_variant_id} → ${a.new_variant_id})`) : `Swap failed: ${r.error}`);
          break;
        }
        case "remove_item": {
          // Delegates to the registry handler, which enumerates every line of
          // the variant on the contract and removes them all (Channing Choate's
          // Salted Caramel x2 AND x1 case), or removes a single line by id.
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "remove_item", {
            contract_id: a.contract_id, variant_id: a.variant_id || a.variantId, line_id: a.line_id || a.lineId,
          });
          results.push(r.success ? (r.summary || "Item removed") : `Remove failed: ${r.error}`);
          break;
        }
        case "change_next_date": {
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "change_next_date", {
            contract_id: a.contract_id, date: a.date,
          });
          results.push(r.success ? (r.summary || `Next billing date set to ${a.date}`) : `Date change failed: ${r.error}`);
          break;
        }
        case "change_frequency": {
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "change_frequency", {
            contract_id: a.contract_id, interval: a.interval, interval_count: a.interval_count,
          });
          results.push(r.success ? (r.summary || `Frequency: every ${a.interval_count} ${a.interval}`) : `Frequency failed: ${r.error}`);
          break;
        }
        case "update_shipping_address": {
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "update_shipping_address", {
            contract_id: a.contract_id, address: a.address,
          });
          results.push(r.success ? (r.summary || "Shipping address updated") : `Address update failed: ${r.error}`);
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
        case "reassign_ticket_customer": {
          // Re-point tickets.customer_id to the correct customer (the typo'd /
          // duplicate-account case — Mindy Freeman a89dcf76). Validate the
          // target customer is in THIS workspace, record a from→to internal
          // note + reason. Pair a `send_magic_link` AFTER this in the same plan
          // so the fresh link resolves to the (now-correct) ticket customer.
          const toCustomerId = String(a.to_customer_id || "");
          if (!toCustomerId) { results.push("reassign_ticket_customer: missing to_customer_id"); break; }
          const { data: t } = await admin.from("tickets").select("customer_id").eq("id", ticketId).single();
          const { data: toCust } = await admin.from("customers")
            .select("id, email, first_name, last_name").eq("id", toCustomerId).eq("workspace_id", workspaceId).maybeSingle();
          if (!toCust) { results.push(`reassign_ticket_customer: target customer ${toCustomerId} not found in workspace`); break; }
          if (t?.customer_id === toCustomerId) { results.push("reassign_ticket_customer: ticket already on that customer"); break; }
          let fromLabel = t?.customer_id || "(none)";
          if (t?.customer_id) {
            const { data: fromCust } = await admin.from("customers").select("email").eq("id", t.customer_id).maybeSingle();
            if (fromCust?.email) fromLabel = `${fromCust.email} (${t.customer_id})`;
          }
          const toLabel = `${toCust.email || `${toCust.first_name || ""} ${toCust.last_name || ""}`.trim()} (${toCustomerId})`;
          const { error: reErr } = await admin.from("tickets")
            .update({ customer_id: toCustomerId, updated_at: new Date().toISOString() })
            .eq("id", ticketId).eq("workspace_id", workspaceId);
          if (reErr) { results.push(`reassign_ticket_customer failed: ${reErr.message}`); break; }
          await admin.from("ticket_messages").insert({
            ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system",
            body: `[Admin Improve] Ticket reassigned: ${fromLabel} → ${toLabel}.${a.reason ? ` Reason: ${a.reason}` : ""}`,
          });
          results.push(`Ticket reassigned to ${toLabel}`);
          break;
        }
        case "send_magic_link": {
          // Generate a portal login link for the ticket's CURRENT customer and
          // email it to that customer's on-file address (no free-text recipient
          // — account access only ever goes to the inbox we have on file). Runs
          // AFTER any reassignment in the same plan, so the right link hits the
          // right inbox. Reuses generateMagicLinkURL + the sendTicketReply path.
          const { data: t } = await admin.from("tickets")
            .select("customer_id, subject, email_message_id").eq("id", ticketId).single();
          if (!t?.customer_id) { results.push("send_magic_link: no customer on ticket"); break; }
          const { data: cust } = await admin.from("customers")
            .select("email, shopify_customer_id").eq("id", t.customer_id).single();
          if (!cust?.email) { results.push("send_magic_link: ticket customer has no email on file"); break; }
          const { generateMagicLinkURL } = await import("@/lib/magic-link");
          const magicUrl = await generateMagicLinkURL(
            t.customer_id, cust.shopify_customer_id || "", cust.email, workspaceId,
          );
          const body = `<p>Here's your personal login link to access your account:</p>${ctaButton(magicUrl, "Log In to My Account")}<p>This link is valid for 24 hours and is unique to you — no password needed.</p>`;
          // Record the outbound external reply on the ticket.
          await admin.from("ticket_messages").insert({
            ticket_id: ticketId, direction: "outbound", visibility: "external",
            author_type: "system", body, sent_at: new Date().toISOString(),
          });
          const { data: wsInfo } = await admin.from("workspaces").select("name, sandbox_mode").eq("id", workspaceId).single();
          if (!wsInfo?.sandbox_mode) {
            const { sendTicketReply } = await import("@/lib/email");
            await sendTicketReply({
              workspaceId, toEmail: cust.email, subject: `Re: ${t.subject || "Your login link"}`,
              body, inReplyTo: t.email_message_id, agentName: "Support", workspaceName: wsInfo?.name || "",
            });
          }
          results.push(`Magic login link sent to ${cust.email}`);
          break;
        }
        case "reactivate": {
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "reactivate", {
            contract_id: a.contract_id, variant_id: a.variant_id,
          });
          results.push(r.success ? (r.summary || "Subscription reactivated") : `Reactivation failed: ${r.error}`);
          break;
        }
        case "update_line_item_price": {
          // Registry handler is the robust path — resolves the live line GID
          // from Appstle and self-heals stale crisis-swap variants.
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "update_line_item_price", {
            contract_id: a.contract_id, variant_id: a.variant_id, base_price_cents: a.base_price_cents,
          });
          results.push(r.success ? (r.summary || `Base price updated to $${(a.base_price_cents / 100).toFixed(2)}`) : `Price update failed: ${r.error}`);
          break;
        }
        case "apply_coupon": {
          // Registry handler adds LOYALTY-* self-heal routing on top of the raw apply.
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "apply_coupon", {
            contract_id: a.contract_id, code: a.code,
          });
          captureContext(actionContext, r);
          results.push(r.success ? (r.summary || `Coupon ${a.code} applied`) : `Coupon failed: ${r.error}`);
          break;
        }
        case "skip_next_order": {
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "skip_next_order", {
            contract_id: a.contract_id,
          });
          results.push(r.success ? (r.summary || "Next order skipped") : `Skip failed: ${r.error}`);
          break;
        }
        case "crisis_pause": {
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "crisis_pause", {
            contract_id: a.contract_id, crisis_action_id: a.crisis_action_id,
          });
          results.push(r.success ? (r.summary || "Subscription paused (crisis)") : `Pause failed: ${r.error}`);
          break;
        }
        case "pause_timed": {
          // Timed pause — pauses now and schedules auto-resume in N days. The
          // registry handler runs the same Appstle + scheduling machinery.
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, "pause_timed", {
            contract_id: a.contract_id, pause_days: a.pause_days || 30,
          });
          results.push(r.success ? (r.summary || `Subscription paused for ${a.pause_days || 30} days`) : `Pause failed: ${r.error}`);
          break;
        }
        case "pause": {
          // Indefinite pause (no auto-resume). Kept bespoke: the registry `pause`
          // handler only supports 30/60-day timed pauses, whereas Improve allows
          // an open-ended pause. Use pause_timed for a specific resume date.
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
        case "unsubscribe_email_marketing":
        case "unsubscribe_sms_marketing":
        case "unsubscribe_all_marketing":
        case "marketing_signup": {
          // Route through the registry handler so the same code path serves
          // both the AI orchestrator and the admin Improve tab. The handlers
          // own the Shopify-side mutation + customers-row update + any
          // Klaviyo/Twilio side effects — we don't re-implement that here.
          const r = await dispatchDirectAction(admin, workspaceId, ticketId, action.type, { code: a.code, reason: a.reason });
          results.push(r.success ? (r.summary || `${action.type} executed`) : `${action.type} failed: ${r.error}`);
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
