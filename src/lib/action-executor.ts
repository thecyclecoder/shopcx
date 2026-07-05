/**
 * Action Executor — executes actions from the Sonnet orchestrator's decision.
 *
 * Takes a SonnetDecision (JSON action plan) and dispatches to the appropriate
 * handler: direct subscription actions, journeys, playbooks, workflows, macros,
 * KB/AI responses, or escalation.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { ctaButton } from "@/lib/label-cta";

// ── Types ──

type Admin = ReturnType<typeof createAdminClient>;

export interface SonnetDecision {
  reasoning: string;
  action_type:
    | "direct_action"
    | "journey"
    | "playbook"
    | "workflow"
    | "macro"
    | "kb_response"
    | "ai_response"
    | "escalate";
  actions?: ActionParams[];
  handler_name?: string;
  response_message?: string;
  needs_clarification?: boolean;
  clarification_question?: string;
}

export interface ActionParams {
  type: string;
  contract_id?: string;
  variant_id?: string;
  old_variant_id?: string;
  new_variant_id?: string;
  quantity?: number;
  interval?: string;
  interval_count?: number;
  date?: string;
  code?: string;
  // Sonnet sometimes emits `coupon_code` for apply_coupon /
  // apply_loyalty_coupon despite the prompt specifying `code`. Accept
  // both — handlers normalize on `code`.
  coupon_code?: string;
  reason?: string;
  tier_index?: number;
  shopify_order_id?: string;
  amount_cents?: number;
  base_price_cents?: number;
  crisis_action_id?: string;
  order_number?: string;
  free_label?: boolean;
  pause_days?: number | string; // model/journey configs may send "60" as a string — coerce with Number() before use
  // Shipping address — used by update_shipping_address (and as an
  // override on create_replacement_order when the customer wants the
  // replacement sent to a different address than the original order).
  address?: {
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;        // 2-letter state/province code (US/CA)
    state?: string;           // alias accepted from prompt catalog
    zip?: string;
    postal_code?: string;     // alias
    country?: string;         // 2-letter country code, default US
    country_code?: string;    // alias
    first_name?: string;
    last_name?: string;
    phone?: string;
  };
  // update_customer_info — change any subset of contact fields on
  // the customer's account profile (separate from a shipping/billing
  // address tied to a specific order/sub). All optional; the handler
  // only touches fields that were provided.
  email?: string;
  phone_number?: string;       // any common format; helper E.164-izes
  first_name?: string;
  last_name?: string;
  // switch_payment_method — set a card as the active payment method
  // on one or all of the customer's active subscriptions. Sonnet
  // identifies the card by last4 (what the customer references in
  // chat); the handler matches it against the Shopify payment methods
  // on file and applies the switch.
  card_last4?: string;
}

export interface ActionContext {
  admin: Admin;
  workspaceId: string;
  ticketId: string;
  customerId: string;
  channel: string;
  sandbox: boolean;
  // Whether a human agent has touched this ticket OR it's already
  // assigned to one. When true, the orchestrator is in limited-scope
  // mode ("agent will be back with you shortly") — any ai_response
  // on an agent-involved ticket is implicitly a hand-off and must
  // flip escalation flags so the assigned agent gets a signal.
  agentInvolved?: boolean;
  // Internal: set by escalateTicket() when this run hands the ticket to
  // an agent. The post-execute auto-close in unified-ticket-handler
  // honors this flag so a ticket that was just escalated doesn't get
  // auto-closed underneath the agent.
  _escalatedThisRun?: boolean;
  // Internal: set by close_ticket direct action. Tells the post-execute
  // logic in unified-ticket-handler that the close was intentional —
  // without this flag the "no message sent → reopen" branch would flip
  // the just-closed ticket back to open.
  _closedThisRun?: boolean;
}

type SendFn = (msg: string, sandbox: boolean) => Promise<void>;
type SysNoteFn = (msg: string) => Promise<void>;

export interface ActionResult {
  success: boolean;
  error?: string;
  summary?: string;
  // Optional customer-facing fields that may appear in response_message
  // via substitution. Set by handlers that produce data the customer
  // needs to see verbatim (return labels, refund amounts, tracking,
  // newly-generated coupon codes).
  labelUrl?: string;
  trackingNumber?: string;
  carrier?: string;
  refundAmountCents?: number;
  couponCode?: string;
}

/**
 * Substitute customer-facing values from a successful ActionResult into
 * a Sonnet-generated response_message. Sonnet cannot know the actual
 * label URL, tracking number, etc. when it builds the response_message
 * (response is generated at the same time as actions, before they run),
 * so it should write the message with placeholder tokens. We fill them
 * in here, after the action completes.
 *
 * Supports both `{{snake_case}}` (the canonical form Sonnet is taught
 * via prompts) and `[UPPER_CASE]` (a bracket form Sonnet sometimes
 * hallucinates without a prompt). Both substitute the same value.
 *
 * `{{label_url}}` is special: it renders as a styled CTA button (not a
 * raw URL) because non-tech-savvy customers don't know to copy/paste a
 * long S3 link into a browser. Same pattern works in both email
 * (table-based for Outlook compat) and the chat widget (which uses
 * dangerouslySetInnerHTML).
 */
// ctaButton lives in label-cta.ts — single source shared with the
// sendWithDelay sink's bare-URL safety net (see renderLabelUrlsAsButtons).

/**
 * Substitute placeholders in an action's string params using results
 * from earlier actions in the same turn. Chained actions like
 * [redeem_points, apply_loyalty_coupon{code:"{{coupon_code}}"}]
 * depend on this — without it, the second action runs with the literal
 * "{{coupon_code}}" string and the downstream API call fails.
 *
 * The map mirrors substituteActionPlaceholders (the message-side helper).
 */
function substituteActionParams(
  action: ActionParams,
  results: { action: ActionParams; result: ActionResult }[],
): ActionParams {
  const map: Record<string, string> = {};
  for (const { result } of results) {
    if (!result.success) continue;
    if (result.couponCode) map.coupon_code = result.couponCode;
    if (result.trackingNumber) map.tracking_number = result.trackingNumber;
    if (result.carrier) map.carrier = result.carrier;
    if (result.labelUrl) map.label_url = result.labelUrl;
  }
  if (Object.keys(map).length === 0) return action;

  const sub = (v: string): string => {
    let out = v;
    for (const [k, val] of Object.entries(map)) {
      out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), val);
      out = out.replace(new RegExp(`\\[\\s*${k.toUpperCase()}\\s*\\]`, "g"), val);
    }
    return out;
  };
  const cloned = { ...action } as unknown as Record<string, unknown>;
  for (const key of Object.keys(cloned)) {
    const v = cloned[key];
    if (typeof v === "string") cloned[key] = sub(v);
  }
  return cloned as unknown as ActionParams;
}

/**
 * Run a list of direct actions inline (used by handleJourney and
 * handlePlaybook when Sonnet wants to fire actions alongside a routing
 * decision — e.g. "create_return + launch cancel_subscription journey").
 *
 * Returns the action results so the caller can substitute placeholders
 * in any follow-up message (e.g. embed the resulting label_url in the
 * journey's lead-in copy).
 *
 * Skips: sandbox mode handling, verify/retry, response_message send —
 * those are the caller's responsibility. This is intentionally a thin
 * helper around firing + logging; handleDirectAction stays the canonical
 * full-flow path.
 */
async function executeActionsInline(
  ctx: ActionContext,
  rawActions: ActionParams[],
  sysNote: SysNoteFn,
): Promise<{ action: ActionParams; result: ActionResult }[]> {
  if (!rawActions.length) return [];

  // Resolve contract IDs — Sonnet might return UUIDs instead of Shopify
  // contract IDs (mirrors handleDirectAction's resolution step).
  const actions = [...rawActions];
  for (const action of actions) {
    if (action.contract_id && action.contract_id.includes("-")) {
      const { data: sub } = await ctx.admin.from("subscriptions")
        .select("shopify_contract_id")
        .eq("id", action.contract_id)
        .maybeSingle();
      if (sub?.shopify_contract_id) action.contract_id = sub.shopify_contract_id;
    }
  }

  const { withActionContext } = await import("@/lib/appstle-call-log");
  const results: { action: ActionParams; result: ActionResult }[] = [];

  for (const action of actions) {
    const handler = directActionHandlers[action.type];
    if (!handler) {
      results.push({ action, result: { success: false, error: `Unknown action type: ${action.type}` } });
      continue;
    }
    const substituted = substituteActionParams(action, results);
    try {
      const result = await withActionContext(
        { workspaceId: ctx.workspaceId, ticketId: ctx.ticketId, customerId: ctx.customerId, actionType: action.type },
        () => handler(ctx, substituted),
      );
      results.push({ action: substituted, result });
    } catch (err) {
      results.push({
        action: substituted,
        result: { success: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  for (const r of results) {
    if (r.result.success) {
      await sysNote(`Action completed: ${r.result.summary || r.action.type}`);
    } else {
      await sysNote(`Action failed: ${r.action.type} — ${r.result.error}`);
    }
  }

  return results;
}

/**
 * Strip any unsubstituted `{{snake_case}}` or `[UPPER_CASE]` tokens from a
 * message. Used in fallback paths (playbook-not-found, journey-not-found,
 * etc.) where we send `decision.response_message` directly without running
 * it through substituteActionPlaceholders.
 *
 * Real failure this prevents: ticket dcb2bf1e (Edward, 2026-05-27). Opus
 * picked action_type=playbook with handler_name="Cancel Subscription"
 * (which is a journey, not a playbook). handlePlaybook's lookup failed,
 * fell through to the "send response_message + escalate" path — and the
 * response_message contained `{{label_url}}`, `{{tracking_number}}`,
 * `{{carrier}}` tokens for a create_return that was never fired. The
 * tokens went to the customer verbatim.
 */
export function stripUnsubstitutedPlaceholders(message: string): string {
  if (!/\{\{\s*\w+\s*\}\}|\[\s*[A-Z_]+\s*\]/.test(message)) return message;
  console.warn("[stripUnsubstitutedPlaceholders] unsubstituted tokens in fallback message:",
    message.match(/\{\{\s*\w+\s*\}\}|\[\s*[A-Z_]+\s*\]/g));
  let out = message
    .replace(/\{\{\s*\w+\s*\}\}/g, "")
    .replace(/\[\s*[A-Z_]+\s*\]/g, "");
  // Clean up empty paragraphs / orphan punctuation that the strip leaves behind
  out = out.replace(/<p>\s*<\/p>/g, "");
  out = out.replace(/\(\s*\)/g, "");
  out = out.replace(/\s*Tracking:\s*\(\s*\)\.?/gi, "");
  out = out.replace(/\s{2,}/g, " ");
  return out;
}

function substituteActionPlaceholders(
  message: string,
  results: { action: ActionParams; result: ActionResult }[],
): string {
  let labelUrl: string | undefined;
  const map: Record<string, string> = {};
  for (const { result } of results) {
    if (!result.success) continue;
    if (result.labelUrl) labelUrl = result.labelUrl; // handled separately as a CTA button
    if (result.trackingNumber) map.tracking_number = result.trackingNumber;
    if (result.carrier) map.carrier = result.carrier;
    if (result.refundAmountCents != null) {
      map.refund_amount = `$${(result.refundAmountCents / 100).toFixed(2)}`;
    }
    if (result.couponCode) map.coupon_code = result.couponCode;
  }
  let out = message;

  // Render label_url as a CTA button, not as raw URL text. This stops
  // the long "https://easypost-files.s3..." link from landing in the
  // body where customers don't know what to do with it.
  if (labelUrl) {
    const button = ctaButton(labelUrl, "Download your prepaid return label →");
    out = out.replace(/\{\{\s*label_url\s*\}\}/g, button);
    out = out.replace(/\[\s*LABEL_URL\s*\]/g, button);
  }

  for (const [key, value] of Object.entries(map)) {
    const lower = `{{\\s*${key}\\s*}}`;
    const upper = `\\[\\s*${key.toUpperCase()}\\s*\\]`;
    out = out.replace(new RegExp(lower, "g"), value);
    out = out.replace(new RegExp(upper, "g"), value);
  }

  // Last-resort guard: strip any unsubstituted action-result placeholders
  // so customers never see literal "{{label_url}}" text. Happens when an
  // action reports success but didn't produce the URL (e.g. EasyPost step
  // failed but Shopify return part succeeded — see ticket 29d6787d, May 6).
  // Anything still wrapped in {{ }} or [UPPER] gets silently removed.
  if (/\{\{\s*\w+\s*\}\}|\[\s*[A-Z_]+\s*\]/.test(out)) {
    console.warn("[substituteActionPlaceholders] Unsubstituted token in message, stripping:", out.match(/\{\{\s*\w+\s*\}\}|\[\s*[A-Z_]+\s*\]/g));
    out = out.replace(/\{\{\s*\w+\s*\}\}/g, "").replace(/\[\s*[A-Z_]+\s*\]/g, "");
    out = out.replace(/<p>\s*<\/p>/g, "");
  }
  return out;
}

// ── Direct Action Handler Registry ──

export const directActionHandlers: Record<
  string,
  (ctx: ActionContext, p: ActionParams) => Promise<ActionResult>
> = {
  resume: async (ctx, p) => {
    const { appstleSubscriptionAction } = await import("@/lib/appstle");
    const r = await appstleSubscriptionAction(ctx.workspaceId, p.contract_id!, "resume");
    return { ...r, summary: "Resumed subscription" };
  },

  // Unsubscribe the customer from email marketing. Fires when a
  // customer messages in saying "unsubscribe me", "stop emailing",
  // "remove me from your list", etc. Updates Shopify (canonical) +
  // local customers row so subsequent campaigns skip them.
  unsubscribe_email_marketing: async (ctx) => {
    const { data: cust } = await ctx.admin.from("customers")
      .select("shopify_customer_id").eq("id", ctx.customerId).single();
    if (!cust?.shopify_customer_id) {
      return { success: false, error: "No Shopify customer id", summary: "Unsubscribe failed: no Shopify id" };
    }
    const { unsubscribeFromEmailMarketing } = await import("@/lib/shopify-marketing");
    const r = await unsubscribeFromEmailMarketing(ctx.workspaceId, cust.shopify_customer_id);
    if (!r.success) return { success: false, error: r.error, summary: `Shopify unsubscribe failed: ${r.error}` };
    await ctx.admin.from("customers").update({
      email_marketing_status: "unsubscribed",
      updated_at: new Date().toISOString(),
    }).eq("id", ctx.customerId);
    return { success: true, summary: "Unsubscribed from email marketing" };
  },

  // Unsubscribe from SMS marketing. Same pattern.
  unsubscribe_sms_marketing: async (ctx) => {
    const { data: cust } = await ctx.admin.from("customers")
      .select("shopify_customer_id").eq("id", ctx.customerId).single();
    if (!cust?.shopify_customer_id) {
      return { success: false, error: "No Shopify customer id", summary: "Unsubscribe failed: no Shopify id" };
    }
    const { unsubscribeFromSmsMarketing } = await import("@/lib/shopify-marketing");
    const r = await unsubscribeFromSmsMarketing(ctx.workspaceId, cust.shopify_customer_id);
    if (!r.success) return { success: false, error: r.error, summary: `Shopify unsubscribe failed: ${r.error}` };
    await ctx.admin.from("customers").update({
      sms_marketing_status: "unsubscribed",
      updated_at: new Date().toISOString(),
    }).eq("id", ctx.customerId);
    return { success: true, summary: "Unsubscribed from SMS marketing" };
  },

  // Unsubscribe from both email AND SMS. Use this when customer says
  // "stop all marketing" / "unsubscribe me from everything".
  unsubscribe_all_marketing: async (ctx) => {
    const { data: cust } = await ctx.admin.from("customers")
      .select("shopify_customer_id").eq("id", ctx.customerId).single();
    if (!cust?.shopify_customer_id) {
      return { success: false, error: "No Shopify customer id", summary: "Unsubscribe failed: no Shopify id" };
    }
    const { unsubscribeFromAllMarketing } = await import("@/lib/shopify-marketing");
    const r = await unsubscribeFromAllMarketing(ctx.workspaceId, cust.shopify_customer_id);
    if (!r.success) return { success: false, error: r.error, summary: `Shopify unsubscribe failed: ${r.error}` };
    await ctx.admin.from("customers").update({
      email_marketing_status: "unsubscribed",
      sms_marketing_status: "unsubscribed",
      updated_at: new Date().toISOString(),
    }).eq("id", ctx.customerId);
    return { success: true, summary: "Unsubscribed from all marketing (email + SMS)" };
  },

  // Flags the ticket as do_not_reply — AI pipeline + auto-analyzer +
  // auto-reopen all short-circuit on future inbound. Used when the
  // customer is reaching out about a product/company we have nothing
  // to do with (wrong company, wrong product, spam, accidental, etc).
  // The Sonnet decision should include response_message — that one
  // message is sent BEFORE the flag is set so the customer gets the
  // "you have the wrong company" clarification once.
  //
  // action params:
  //   reason: machine tag — "wrong_product" | "wrong_company" | "spam"
  //           | "accidental_send" | "other". Gets stamped as a ticket
  //           tag for analytics.
  deactivate_ticket: async (ctx, p) => {
    const reason = p.reason || "wrong_company";
    const now = new Date().toISOString();
    const tag = reason.startsWith("wrong_") || reason === "spam" || reason === "accidental_send"
      ? reason
      : `do_not_reply:${reason}`;

    const { error } = await ctx.admin
      .from("tickets")
      .update({
        do_not_reply: true,
        do_not_reply_at: now,
        status: "closed",
        updated_at: now,
      })
      .eq("id", ctx.ticketId);
    if (error) return { success: false, error: error.message, summary: `Deactivate failed: ${error.message}` };

    const { addTicketTag } = await import("@/lib/ticket-tags");
    await addTicketTag(ctx.ticketId, tag);
    return { success: true, summary: `Deactivated ticket (reason: ${reason})` };
  },

  skip_next_order: async (ctx, p) => {
    const { appstleSkipNextOrder } = await import("@/lib/appstle");
    const r = await appstleSkipNextOrder(ctx.workspaceId, p.contract_id!);
    return { ...r, summary: "Skipped next order" };
  },

  change_frequency: async (ctx, p) => {
    const { appstleUpdateBillingInterval } = await import("@/lib/appstle");
    const r = await appstleUpdateBillingInterval(
      ctx.workspaceId, p.contract_id!, p.interval! as "DAY" | "WEEK" | "MONTH" | "YEAR", Number(p.interval_count!),
    );
    return { ...r, summary: `Changed frequency to every ${p.interval_count} ${p.interval}` };
  },

  change_next_date: async (ctx, p) => {
    const { appstleUpdateNextBillingDate, orderNowByContract } = await import("@/lib/appstle");
    // Appstle rejects past/today timestamps. If Sonnet passes a date
    // ≤ today (Central) — which it does when a customer says "ship
    // it ASAP" or "send right away" — we don't shove next_billing
    // into the future; we just charge now via order-now. This matches
    // customer intent (get product TODAY) and avoids the 400 we used
    // to bounce on. orderNowByContract is flavor-aware (internal → Braintree
    // renewal pipeline, Appstle → attempt-billing); a raw appstle call here
    // silently no-ops on internal subs.
    let date = p.date!;
    const centralToday = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
    centralToday.setHours(0, 0, 0, 0);
    const requested = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00`) : new Date(date);
    if (!isNaN(requested.getTime()) && requested.getTime() <= centralToday.getTime()) {
      const billed = await orderNowByContract(ctx.workspaceId, p.contract_id!);
      if (billed.success) {
        return { success: true, summary: "Triggered order now (customer asked to ship today)" };
      }
      // order-now failed → fall through to bumping date as a soft fallback
      console.warn(`[change_next_date] order-now fallback failed for ${p.contract_id}:`, billed.error);
      const tomorrow = new Date(centralToday);
      tomorrow.setDate(tomorrow.getDate() + 1);
      date = tomorrow.toISOString().slice(0, 10);
      p.date = date;
    }
    const r = await appstleUpdateNextBillingDate(ctx.workspaceId, p.contract_id!, date);
    return { ...r, summary: `Changed next billing date to ${date}` };
  },

  /**
   * bill_now — charge the current upcoming order on a sub right
   * away. Use this when the customer says "ship it now", "ASAP",
   * "I'm out of product". Does NOT change next_billing_date — after
   * the charge, the schedule advances by one cycle. Flavor-aware:
   * internal subs fire the Braintree renewal pipeline, Appstle subs
   * attempt the upcoming Appstle billing (orderNowByContract).
   */
  bill_now: async (ctx, p) => {
    const { orderNowByContract } = await import("@/lib/appstle");
    if (!p.contract_id) return { success: false, error: "bill_now missing contract_id" };
    return orderNowByContract(ctx.workspaceId, p.contract_id);
  },

  add_item: async (ctx, p) => {
    const { subAddItem } = await import("@/lib/subscription-items");
    const r = await subAddItem(ctx.workspaceId, p.contract_id!, p.variant_id!, p.quantity || 1);
    return { ...r, summary: `Added item (qty: ${p.quantity || 1})` };
  },

  /**
   * remove_item — remove all line_items of a given variant from a
   * subscription. Robust to the two failure modes observed in the
   * wild:
   *   1. Sonnet sometimes emits `variantId` (camelCase) instead of
   *      `variant_id`. We accept both.
   *   2. Customers split the same product across multiple lines
   *      (e.g. Channing Choate had Salted Caramel × 2 AND × 1 as two
   *      separate line items, qty=3 total). Sonnet's "remove the
   *      creamer" intent should clear ALL lines of that variant, not
   *      just the first match. The handler now loops Appstle's
   *      single-line endpoint until no lines of the variant remain.
   */
  remove_item: async (ctx, p) => {
    const { subRemoveItem } = await import("@/lib/subscription-items");
    const pe = p as { variantId?: string; line_id?: string; lineId?: string };
    const variantId = p.variant_id || pe.variantId;
    const lineId = pe.line_id || pe.lineId;

    if (!p.contract_id) return { success: false, error: "remove_item missing contract_id" };
    if (!variantId && !lineId) return { success: false, error: "remove_item needs variant_id or line_id" };

    // Single-line removal (caller already knows the lineId)
    if (lineId && !variantId) {
      const r = await subRemoveItem(ctx.workspaceId, p.contract_id, { lineGid: lineId });
      return { ...r, summary: "Removed item" };
    }

    // Variant-driven removal — fetch live contract lines, then loop
    // over EVERY line matching the variant_id. Multi-line case (same
    // variant, different lines) is common when customers built up the
    // sub over time. Stop on first failure so we don't keep hammering
    // Appstle if its credentials died mid-loop.
    type Line = { id?: string; variantId?: string };
    const { getAppstleConfig } = await import("@/lib/subscription-items");
    const cfg = await getAppstleConfig(ctx.workspaceId);
    if (!cfg) return { success: false, error: "Appstle not configured" };
    const cRes = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${p.contract_id}?api_key=${cfg.apiKey}`,
      { cache: "no-store" },
    );
    if (!cRes.ok) return { success: false, error: `Contract fetch failed: ${cRes.status}` };
    const cJson = await cRes.json();
    const lines = ((cJson.lines?.nodes || []) as Line[])
      .filter((l) => {
        const vid = String(l.variantId || "").split("/").pop();
        return vid === String(variantId);
      });
    if (lines.length === 0) {
      return { success: false, error: `No lines matching variant ${variantId} on contract` };
    }

    let removed = 0;
    for (const ln of lines) {
      if (!ln.id) continue;
      const r = await subRemoveItem(ctx.workspaceId, p.contract_id, { lineGid: ln.id });
      if (!r.success) {
        return { success: removed > 0, error: `Removed ${removed} of ${lines.length} lines, then failed: ${r.error}` };
      }
      removed++;
    }
    return { success: true, summary: `Removed ${removed} line${removed > 1 ? "s" : ""} of variant ${variantId}` };
  },

  swap_variant: async (ctx, p) => {
    const { subSwapVariant } = await import("@/lib/subscription-items");
    // Accept both naming styles — the prompts catalog used "old_id"/
    // "new_id" historically; the action interface is "old_variant_id"/
    // "new_variant_id". When Opus follows the catalog literally we'd
    // get `undefined` and ship NaN to Appstle (400). Alias both.
    const pe = p as { old_id?: string; new_id?: string; old_variant?: string; new_variant?: string };
    const oldVid = p.old_variant_id || pe.old_id || pe.old_variant;
    const newVid = p.new_variant_id || pe.new_id || pe.new_variant;
    if (!oldVid || !newVid) {
      return { success: false, error: `swap_variant missing variant ids — got old=${oldVid} new=${newVid}` };
    }
    const r = await subSwapVariant(
      ctx.workspaceId, p.contract_id!, oldVid, newVid, p.quantity || 1,
    );
    return { ...r, summary: `Swapped variant ${oldVid} → ${newVid}` };
  },

  change_quantity: async (ctx, p) => {
    const { subSwapVariant } = await import("@/lib/subscription-items");
    // Change qty by swapping variant to itself with new quantity
    const r = await subSwapVariant(
      ctx.workspaceId, p.contract_id!, p.variant_id!, p.variant_id!, p.quantity!,
    );
    return { ...r, summary: `Changed quantity to ${p.quantity}` };
  },

  apply_coupon: async (ctx, p) => {
    const code = p.code || p.coupon_code;
    if (!code) return { success: false, error: "Missing coupon code (pass via 'code')" };

    // Defensive routing: any LOYALTY-* code transparently goes through
    // apply_loyalty_coupon, which has self-heal (regenerate-on-fail). Sonnet
    // sometimes emits apply_coupon for loyalty codes despite the prompt rule;
    // the wrong-action choice would otherwise leak Appstle 400s straight to
    // escalation (Gawain Wood, 2026-05-05).
    if (/^LOYALTY-/i.test(code)) {
      return directActionHandlers.apply_loyalty_coupon(ctx, p);
    }

    const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
    const { getAppstleConfig } = await import("@/lib/subscription-items");
    const config = await getAppstleConfig(ctx.workspaceId);
    if (!config) return { success: false, error: "Appstle not configured" };
    const r = await applyDiscountWithReplace(config.apiKey, p.contract_id!, code);
    return { ...r, summary: `Applied coupon ${code}` };
  },

  remove_coupon: async (ctx, p) => {
    const { removeExistingDiscounts } = await import("@/lib/appstle-discount");
    const { getAppstleConfig } = await import("@/lib/subscription-items");
    const config = await getAppstleConfig(ctx.workspaceId);
    if (!config) return { success: false, error: "Appstle not configured" };
    const r = await removeExistingDiscounts(config.apiKey, p.contract_id!);
    return { success: !r.error, error: r.error, summary: "Removed coupon" };
  },

  redeem_points: async (ctx, p) => {
    const { getLoyaltySettings, getRedemptionTiers, validateRedemption, spendPoints } = await import("@/lib/loyalty");
    const { getShopifyCredentials } = await import("@/lib/shopify-sync");
    const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");

    const settings = await getLoyaltySettings(ctx.workspaceId);
    const tiers = getRedemptionTiers(settings);
    const tier = tiers[p.tier_index!];
    if (!tier) return { success: false, error: "Invalid tier" };

    const { data: member } = await ctx.admin
      .from("loyalty_members")
      .select("*")
      .eq("customer_id", ctx.customerId)
      .eq("workspace_id", ctx.workspaceId)
      .single();
    if (!member) return { success: false, error: "No loyalty member" };

    const validation = validateRedemption(member, tier);
    if (!validation.valid) return { success: false, error: validation.error };

    // Generate unique discount code
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let random = "";
    for (let i = 0; i < 6; i++) random += chars[Math.floor(Math.random() * chars.length)];
    const code = `LOYALTY-${tier.discount_value}-${random}`;

    const { shop, accessToken } = await getShopifyCredentials(ctx.workspaceId);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (settings.coupon_expiry_days || 90));

    // Create Shopify discount via GraphQL
    const gqlRes = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
            codeDiscountNode { id }
            userErrors { field message }
          }
        }`,
        variables: {
          basicCodeDiscount: {
            title: `Loyalty $${tier.discount_value} (${code})`,
            code,
            startsAt: new Date().toISOString(),
            endsAt: expiresAt.toISOString(),
            usageLimit: 1,
            appliesOncePerCustomer: true,
            customerSelection: {
              customers: {
                add: [`gid://shopify/Customer/${member.shopify_customer_id}`],
              },
            },
            combinesWith: {
              productDiscounts: settings.coupon_combines_product,
              shippingDiscounts: settings.coupon_combines_shipping,
              orderDiscounts: settings.coupon_combines_order,
            },
            customerGets: {
              appliesOnOneTimePurchase: settings.coupon_applies_to !== "subscription",
              appliesOnSubscription: settings.coupon_applies_to !== "one_time",
              items: { all: true },
              value: {
                discountAmount: {
                  amount: tier.discount_value,
                  appliesOnEachItem: false,
                },
              },
            },
          },
        },
      }),
    });
    const gql = await gqlRes.json();
    const errors = gql?.data?.discountCodeBasicCreate?.userErrors;
    if (errors?.length) {
      return {
        success: false,
        error: errors.map((e: { message: string }) => e.message).join(", "),
      };
    }

    const discountId = gql?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null;
    await spendPoints(member, tier.points_cost, `Redeemed ${tier.label}`, discountId);
    await ctx.admin.from("loyalty_redemptions").insert({
      workspace_id: ctx.workspaceId,
      member_id: member.id,
      reward_tier: tier.label,
      points_spent: tier.points_cost,
      discount_code: code,
      shopify_discount_id: discountId,
      discount_value: tier.discount_value,
      status: "active",
      expires_at: expiresAt.toISOString(),
    });

    return {
      success: true,
      summary: `Redeemed ${tier.points_cost} points for $${tier.discount_value} off (code: ${code})`,
      couponCode: code,
    };
  },

  apply_loyalty_coupon: async (ctx, p) => {
    const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
    const { getAppstleConfig } = await import("@/lib/subscription-items");
    const config = await getAppstleConfig(ctx.workspaceId);
    if (!config) return { success: false, error: "Appstle not configured" };

    const code = p.code || p.coupon_code;
    if (!code) return { success: false, error: "Missing coupon code (pass via 'code')" };

    // Brief delay — coupon may have just been created in Shopify and needs a moment to propagate
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Try applying the existing coupon first
    const r = await applyDiscountWithReplace(config.apiKey, p.contract_id!, code);
    if (r.success) return { ...r, summary: `Applied loyalty coupon ${code}` };

    // Coupon failed — may be stale/deleted in Shopify. Generate a fresh one.
    try {
      const { getLoyaltySettings, getRedemptionTiers, spendPoints } = await import("@/lib/loyalty");
      const { getShopifyCredentials } = await import("@/lib/shopify-sync");
      const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");

      // Find the original redemption to get tier info
      const { data: orig } = await ctx.admin.from("loyalty_redemptions")
        .select("id, member_id, discount_value, points_spent")
        .eq("discount_code", code).eq("workspace_id", ctx.workspaceId).single();
      if (!orig) return { success: false, error: `Original coupon not found and apply failed: ${r.error}` };

      // Get member
      const { data: member } = await ctx.admin.from("loyalty_members")
        .select("*").eq("id", orig.member_id).single();
      if (!member) return { success: false, error: "Loyalty member not found" };

      const settings = await getLoyaltySettings(ctx.workspaceId);
      const { shop, accessToken } = await getShopifyCredentials(ctx.workspaceId);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + (settings.coupon_expiry_days || 90));

      // Generate new code
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let random = "";
      for (let i = 0; i < 6; i++) random += chars[Math.floor(Math.random() * chars.length)];
      const newCode = `LOYALTY-${orig.discount_value}-${random}`;

      // Create new Shopify discount
      const gqlRes = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) { codeDiscountNode { id } userErrors { field message } } }`,
          variables: { basicCodeDiscount: {
            title: `Loyalty $${orig.discount_value} (${newCode})`, code: newCode,
            startsAt: new Date().toISOString(), endsAt: expiresAt.toISOString(),
            usageLimit: 1, appliesOncePerCustomer: true,
            customerSelection: { customers: { add: [`gid://shopify/Customer/${member.shopify_customer_id}`] } },
            combinesWith: { productDiscounts: settings.coupon_combines_product, shippingDiscounts: settings.coupon_combines_shipping, orderDiscounts: settings.coupon_combines_order },
            customerGets: { appliesOnOneTimePurchase: settings.coupon_applies_to !== "subscription", appliesOnSubscription: settings.coupon_applies_to !== "one_time", items: { all: true }, value: { discountAmount: { amount: orig.discount_value, appliesOnEachItem: false } } },
          }},
        }),
      });
      const gql = await gqlRes.json();
      const errors = gql?.data?.discountCodeBasicCreate?.userErrors;
      if (errors?.length) return { success: false, error: `Failed to regenerate coupon: ${errors.map((e: { message: string }) => e.message).join(", ")}` };

      const discountId = gql?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null;

      // Refund points from old broken redemption, then spend for new one
      // This way the points ledger is clean — old one refunded, new one properly redeemed
      await ctx.admin.from("loyalty_members").update({
        points_balance: member.points_balance + orig.points_spent,
      }).eq("id", member.id);
      // Re-read member with updated balance for spendPoints
      const { data: refreshedMember } = await ctx.admin.from("loyalty_members").select("*").eq("id", member.id).single();

      await ctx.admin.from("loyalty_redemptions").update({ status: "expired" }).eq("id", orig.id);

      if (refreshedMember) {
        const tiers = getRedemptionTiers(settings);
        const tier = tiers.find(t => t.discount_value === orig.discount_value);
        if (tier) {
          await spendPoints(refreshedMember, tier.points_cost, `Redeemed ${tier.label} (regenerated)`, discountId);
        }
      }

      await ctx.admin.from("loyalty_redemptions").insert({
        workspace_id: ctx.workspaceId, member_id: member.id,
        reward_tier: `$${orig.discount_value} Off`, points_spent: orig.points_spent,
        discount_code: newCode, shopify_discount_id: discountId,
        discount_value: orig.discount_value, status: "active",
        expires_at: expiresAt.toISOString(),
      });

      // Now apply the fresh coupon
      const r2 = await applyDiscountWithReplace(config.apiKey, p.contract_id!, newCode);
      if (r2.success) {
        return { success: true, summary: `Applied loyalty coupon $${orig.discount_value} off (regenerated: ${newCode})`, couponCode: newCode };
      }
      return { success: false, error: `Regenerated coupon also failed: ${r2.error}` };
    } catch (e) {
      return { success: false, error: `Coupon regeneration failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },

  update_line_item_price: async (ctx, p) => {
    const { subUpdateLineItemPrice } = await import("@/lib/subscription-items");
    const { getAppstleConfig } = await import("@/lib/subscription-items");

    if (!p.contract_id) return { success: false, error: "Missing contract_id" };
    if (p.base_price_cents == null) return { success: false, error: "Missing base_price_cents" };

    // Internal subs aren't on Appstle — restore the grandfathered base by
    // writing price_override_cents directly. Route here FIRST, before the
    // Appstle config / live-contract fetch below (which would fail with
    // "Appstle not configured" for an internal sub). subUpdateLineItemPrice
    // delegates to internalSubUpdateLineItemPrice for these.
    const { isInternalSubscription } = await import("@/lib/internal-subscription");
    if (await isInternalSubscription(ctx.workspaceId, p.contract_id)) {
      if (!p.variant_id) return { success: false, error: "Internal subscription requires a variant_id to restore price" };
      const r = await subUpdateLineItemPrice(ctx.workspaceId, p.contract_id, String(p.variant_id), p.base_price_cents);
      return r.success
        ? { ...r, summary: `Restored base price to $${((p.base_price_cents || 0) / 100).toFixed(2)} on variant ${p.variant_id} (internal price_override_cents)` }
        : r;
    }

    // Build candidate variants in priority order:
    //   1. Sonnet's explicit p.variant_id (most accurate when actions are chained)
    //   2. Crisis tier2 / tier1 swap targets
    //   3. Default swap variant from crisis event
    //   4. Real (non-shipping-protection) items currently on the subscription
    const candidates: string[] = [];
    const pushUnique = (v: string | undefined | null) => {
      if (v && !candidates.includes(String(v))) candidates.push(String(v));
    };
    pushUnique(p.variant_id);

    const { data: crisisAction } = await ctx.admin.from("crisis_customer_actions")
      .select("tier1_swapped_to, tier2_swapped_to, crisis_id")
      .eq("customer_id", ctx.customerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (crisisAction) {
      pushUnique((crisisAction.tier2_swapped_to as { variantId?: string } | null)?.variantId);
      pushUnique((crisisAction.tier1_swapped_to as { variantId?: string } | null)?.variantId);
      if (crisisAction.crisis_id) {
        const { data: crisis } = await ctx.admin.from("crisis_events")
          .select("default_swap_variant_id").eq("id", crisisAction.crisis_id).maybeSingle();
        pushUnique(crisis?.default_swap_variant_id);
      }
    }

    const { data: sub } = await ctx.admin.from("subscriptions").select("items").eq("shopify_contract_id", p.contract_id).single();
    const subItems = (sub?.items as { variant_id?: string; title?: string }[]) || [];
    const subRealItems = subItems.filter(i => !(i.title || "").toLowerCase().includes("shipping protection"));
    for (const it of subRealItems) pushUnique(it.variant_id);

    // Fetch the live contract from Appstle ONCE — source of truth for current line GIDs.
    // After a swap, our DB items/variants may match but the customer-facing variant id
    // changes, so we always resolve lineId from live Appstle data.
    const config = await getAppstleConfig(ctx.workspaceId);
    if (!config) return { success: false, error: "Appstle not configured" };
    let liveLines: { id: string; variantId: string; title?: string }[] = [];
    try {
      const detailRes = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${p.contract_id}?api_key=${config.apiKey}`,
        { headers: { "X-API-Key": config.apiKey }, cache: "no-store" },
      );
      if (detailRes.ok) {
        const detail = await detailRes.json();
        const nodes = (detail?.lines?.nodes || []) as { id?: string; variantId?: string; title?: string }[];
        liveLines = nodes
          .filter(n => n.id && n.variantId)
          .map(n => ({ id: n.id!, variantId: (n.variantId!.split("/").pop() || n.variantId!) as string, title: n.title }));
      }
    } catch (e) {
      console.error("update_line_item_price: live contract fetch failed:", e);
    }

    // Try each candidate against the live contract.
    for (const variantId of candidates) {
      const match = liveLines.find(l => String(l.variantId) === String(variantId));
      if (match) {
        const r = await subUpdateLineItemPrice(ctx.workspaceId, p.contract_id, variantId, p.base_price_cents, match.id);
        if (r.success) return { ...r, summary: `Updated base price to $${((p.base_price_cents || 0) / 100).toFixed(2)} on variant ${variantId}` };
        // Different error (not a lineId resolution issue) — surface it
        if (!String(r.error || "").toLowerCase().includes("could not resolve lineid")) return r;
      }
    }

    // Self-heal: grandfathered pricing applies to variants of the same product
    // (e.g. all flavors of Superfood Tabs share grandfathered pricing). If no
    // candidate variant matches the live contract, look up the product_id of
    // a candidate and find a live line whose variant belongs to that product.
    // Covers the case where the customer swapped back from a crisis substitute
    // and the crisis context is now stale.
    const liveReal = liveLines.filter(l => !(l.title || "").toLowerCase().includes("shipping protection"));
    if (candidates.length > 0 && liveReal.length > 0) {
      // Find the product_id for any candidate variant by scanning the products table.
      const { data: products } = await ctx.admin.from("products")
        .select("shopify_product_id, variants")
        .eq("workspace_id", ctx.workspaceId);
      let candidateProductId: string | null = null;
      for (const candidate of candidates) {
        for (const prod of products || []) {
          const variants = (prod.variants || []) as { id?: string }[];
          if (variants.some(v => String(v.id) === String(candidate))) {
            candidateProductId = prod.shopify_product_id as string;
            break;
          }
        }
        if (candidateProductId) break;
      }

      if (candidateProductId) {
        // Build variant_id → product_id map from our products table
        const variantToProduct = new Map<string, string>();
        for (const prod of products || []) {
          for (const v of (prod.variants || []) as { id?: string }[]) {
            if (v.id) variantToProduct.set(String(v.id), prod.shopify_product_id as string);
          }
        }
        const sameProductLine = liveReal.find(l => variantToProduct.get(String(l.variantId)) === candidateProductId);
        if (sameProductLine) {
          const r = await subUpdateLineItemPrice(ctx.workspaceId, p.contract_id, sameProductLine.variantId, p.base_price_cents, sameProductLine.id);
          if (r.success) return { ...r, summary: `Updated base price to $${((p.base_price_cents || 0) / 100).toFixed(2)} on variant ${sameProductLine.variantId} (self-healed: candidate variant was stale, matched same product)` };
          return r;
        }
      }
    }

    return {
      success: false,
      error: liveReal.length === 0
        ? "Live contract has no real line items"
        : `Could not match any candidate variant against ${liveReal.length} live line items, and no live line shares a product with any candidate. candidates=[${candidates.join(", ")}], live=[${liveReal.map(l => l.variantId).join(", ")}]`,
    };
  },

  create_return: async (ctx, p) => {
    const { createFullReturn } = await import("@/lib/shopify-returns");
    const admin = createAdminClient();

    // HARD INVARIANT: at most ONE return per ticket. We never issue more
    // than a single return in one interaction — a second is a human
    // decision, not an AI one. The orchestrator once read "one label per
    // order" and created THREE returns in a single turn (3 EasyPost labels +
    // 3× refund exposure) for a hospitalized customer with 3 unwanted
    // shipments (Traci Studebaker, ticket 1b62b00f, 2026-06-19). Actions run
    // sequentially, so the first create_return wins and any sibling/repeat
    // attempt is blocked here and escalated. (Dylan, 2026-06-19.)
    if (ctx.ticketId) {
      const { data: existingReturns } = await admin.from("returns")
        .select("id, order_id, status")
        .eq("ticket_id", ctx.ticketId)
        .neq("status", "cancelled");
      if (existingReturns && existingReturns.length > 0) {
        return {
          success: false,
          error: `A return already exists on this ticket (${existingReturns[0].id}). Policy: never more than one return per ticket — escalate any additional return to a human instead of creating it.`,
        };
      }
    }

    // Look up order
    const { data: order } = await admin.from("orders")
      .select("id, order_number, shopify_order_id, shipping_address")
      .eq("workspace_id", ctx.workspaceId)
      .eq("order_number", p.order_number!)
      .single();
    if (!order) return { success: false, error: `Order ${p.order_number} not found` };

    // Look up customer
    const { data: customer } = await admin.from("customers")
      .select("id, first_name, last_name, phone")
      .eq("id", ctx.customerId!)
      .single();

    const addr = order.shipping_address as Record<string, string> | null;
    if (!addr) return { success: false, error: "No shipping address on order" };

    const r = await createFullReturn({
      workspaceId: ctx.workspaceId,
      orderId: order.id,
      orderNumber: order.order_number,
      // Internal orders (SHOPCX*) have no Shopify order → pass null so createFullReturn takes its
      // internal path (build the return from line_items, refund via Braintree) instead of fabricating
      // a `gid://shopify/Order/null` that fails the Shopify lookup.
      shopifyOrderGid: order.shopify_order_id ? `gid://shopify/Order/${order.shopify_order_id}` : null,
      customerId: ctx.customerId!,
      ticketId: ctx.ticketId,
      customerName: `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || "Customer",
      customerPhone: customer?.phone || undefined,
      shippingAddress: {
        street1: addr.address1 || addr.street1 || "",
        city: addr.city || "",
        state: addr.province_code || addr.provinceCode || addr.state || "",
        zip: addr.zip || "",
        country: addr.country_code || addr.countryCode || "US",
      },
      source: "ai",
      freeLabel: !!p.free_label,
    });

    if (r.success && r.labelUrl) {
      return {
        success: true,
        summary: `Return created for ${order.order_number}. Label: ${r.labelUrl} | Tracking: ${r.trackingNumber}`,
        labelUrl: r.labelUrl,
        trackingNumber: r.trackingNumber,
        carrier: r.carrier,
      };
    }
    return { ...r, summary: r.success ? `Return created for ${order.order_number}` : undefined };
  },

  partial_refund: async (ctx, p) => {
    const { refundOrder } = await import("@/lib/refund");
    const amountDecimal = ((p.amount_cents || 0) / 100).toFixed(2);
    const reason = p.reason || "Price adjustment — customer was overcharged";

    if (!p.shopify_order_id) return { success: false, error: "Missing shopify_order_id" };
    if (!p.amount_cents) return { success: false, error: "Missing amount_cents" };

    // Resolve internal order UUID — refundOrder takes our internal
    // orders.id, never the human-facing shopify_order_id / order_number.
    const oid = String(p.shopify_order_id);
    const orderMatch = /^\d+$/.test(oid) ? { col: "shopify_order_id", val: oid } : { col: "order_number", val: oid };
    const { data: ord } = await ctx.admin.from("orders").select("id").eq(orderMatch.col, orderMatch.val).eq("workspace_id", ctx.workspaceId).maybeSingle();
    if (!ord?.id) return { success: false, error: `Order not found for ${oid}` };

    // refundOrder dispatches on the order's gateway (Braintree /
    // Shopify), preserves the double-refund guard (stamps refunded_at
    // on open returns), and logs the customer_events row.
    const r = await refundOrder(ctx.workspaceId, ord.id, p.amount_cents, reason, {
      source: "ai",
      customerId: ctx.customerId,
      eventProperties: { ticket_id: ctx.ticketId },
    });
    if (r.success) await notifySlack(ctx, p, amountDecimal);

    // When the refund went directly through Braintree (Shopify's native
    // Braintree refund is broken), record that on the ticket so agents/AI
    // reading the thread know the money moved off-Shopify, with the Braintree
    // refund id for reconciliation. Note any failed Shopify-side bookkeeping.
    let methodNote = "";
    if (r.success && r.method === "braintree") {
      methodNote = ` — refunded directly via Braintree${r.refund_id ? ` (txn ${r.refund_id})` : ""}${r.needsManualShopifyRecord ? "; Shopify record needs manual reconciliation" : ", recorded on the Shopify order"}`;
    }
    return {
      success: r.success,
      error: r.error,
      summary: r.success ? `Partial refund of $${amountDecimal} issued (${reason})${methodNote}` : undefined,
      // Drives {{refund_amount}} substitution in response_message. Without
      // this, the placeholder leaked through verbatim — see ticket
      // 8203dfe0 (May 5), Amanda Lederman's $6.95 shipping refund.
      refundAmountCents: r.success ? (p.amount_cents || 0) : undefined,
    };
  },

  redeem_points_as_refund: async (ctx, p) => {
    const { getLoyaltySettings, getRedemptionTiers, validateRedemption, spendPoints } = await import("@/lib/loyalty");
    const { refundOrder } = await import("@/lib/refund");

    if (!p.shopify_order_id) return { success: false, error: "Missing shopify_order_id" };
    if (p.tier_index == null) return { success: false, error: "Missing tier_index" };

    const settings = await getLoyaltySettings(ctx.workspaceId);
    const tiers = getRedemptionTiers(settings);
    const tier = tiers[p.tier_index];
    if (!tier) return { success: false, error: "Invalid tier" };

    const { data: member } = await ctx.admin
      .from("loyalty_members")
      .select("*")
      .eq("workspace_id", ctx.workspaceId)
      .eq("customer_id", ctx.customerId)
      .single();
    if (!member) return { success: false, error: "No loyalty member" };

    const validation = validateRedemption(member, tier);
    if (!validation.valid) return { success: false, error: validation.error };

    const { data: order } = await ctx.admin.from("orders")
      .select("id, order_number, total_cents, financial_status")
      .eq("workspace_id", ctx.workspaceId).eq("shopify_order_id", p.shopify_order_id).single();
    if (!order) return { success: false, error: "Order not found" };
    if (order.financial_status === "refunded") return { success: false, error: "Order already fully refunded" };

    const amountCents = tier.discount_value * 100;
    const reason = `Loyalty redemption — ${tier.points_cost} points for $${tier.discount_value} partial refund on renewal order #${order.order_number}`;

    const refund = await refundOrder(ctx.workspaceId, order.id, amountCents, reason, {
      source: "ai",
      customerId: ctx.customerId,
      eventProperties: { ticket_id: ctx.ticketId, loyalty_tier: tier.label, points_spent: tier.points_cost },
    });
    if (!refund.success) return { success: false, error: refund.error };

    await spendPoints(member, tier.points_cost, `Redeemed for partial refund on order #${order.order_number}`, null);

    await ctx.admin.from("loyalty_redemptions").insert({
      workspace_id: ctx.workspaceId,
      member_id: member.id,
      reward_tier: tier.label,
      points_spent: tier.points_cost,
      discount_code: `REFUND-${order.order_number}-${Date.now()}`,
      shopify_discount_id: null,
      discount_value: tier.discount_value,
      status: "redeemed_as_refund",
      used_at: new Date().toISOString(),
    });

    const newBalance = Math.max(0, (member.points_balance || 0) - tier.points_cost);
    return {
      success: true,
      summary: `Redeemed ${tier.points_cost} points for $${tier.discount_value} partial refund on order #${order.order_number} (balance: ${newBalance} pts)`,
      refundAmountCents: amountCents,
    };
  },

  pause_timed: async (ctx, p) => {
    const { appstleSubscriptionAction } = await import("@/lib/appstle");
    if (!p.contract_id) return { success: false, error: "Missing contract_id" };
    // We only ever do 30- or 60-day pauses. Coerce before validating: the
    // orchestrator and journey configs carry pause_days as a STRING ("60"), so a
    // strict `=== 60` would reject a valid 60-day request (caught on Susan Maex's
    // pause — the string "60" failed the numeric guard and the pause never ran).
    const days = Number(p.pause_days);
    if (days !== 30 && days !== 60) return { success: false, error: "pause_days must be 30 or 60" };

    const r = await appstleSubscriptionAction(
      ctx.workspaceId, p.contract_id, "pause",
      `Customer requested ${days}-day pause after renewal charge`,
    );
    if (!r.success) return { ...r, summary: undefined };

    const resumeAt = new Date(Date.now() + days * 86400000);
    await ctx.admin.from("subscriptions")
      .update({
        status: "paused",
        pause_resume_at: resumeAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", ctx.workspaceId)
      .eq("shopify_contract_id", p.contract_id);

    const resumeLabel = resumeAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    return { success: true, summary: `Paused for ${days} days (auto-resumes ${resumeLabel})` };
  },

  // Alias: Sonnet sometimes emits { type: "pause" } expecting the same behavior
  // as pause_timed. Default to 30 days if no duration specified. 30/60 only.
  pause: async (ctx, p) => {
    const days = Number(p.pause_days) || 30;
    if (days !== 30 && days !== 60) {
      return {
        success: false,
        error: `pause action only supports 30 or 60 day durations (got ${p.pause_days}). For anything else, an agent must apply manually.`,
      };
    }
    return directActionHandlers.pause_timed(ctx, { ...p, pause_days: days });
  },

  // Link the ticket customer's account to another customer profile by email.
  // Use when the customer has confirmed in text that another email belongs to
  // them (e.g. "yes both are mine", "the other email is X@Y.com") — avoids
  // bouncing them through the account_linking form when their text answer is clear.
  link_account_by_email: async (ctx, p) => {
    if (!p.code) return { success: false, error: "Missing email (pass via 'code' param)" };
    const targetEmail = p.code.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(targetEmail)) return { success: false, error: `Invalid email: ${targetEmail}` };

    // Find a customer in this workspace with the email
    const { data: target } = await ctx.admin.from("customers")
      .select("id, email")
      .eq("workspace_id", ctx.workspaceId)
      .ilike("email", targetEmail)
      .maybeSingle();
    if (!target) return { success: false, error: `No customer profile found for ${targetEmail}` };
    if (target.id === ctx.customerId) return { success: false, error: "Target email is the same customer" };

    // Check existing groups
    const { data: ownerLink } = await ctx.admin.from("customer_links")
      .select("group_id, is_primary").eq("customer_id", ctx.customerId).maybeSingle();
    const { data: targetLink } = await ctx.admin.from("customer_links")
      .select("group_id").eq("customer_id", target.id).maybeSingle();

    if (ownerLink && targetLink && ownerLink.group_id === targetLink.group_id) {
      return { success: true, summary: `Already linked: ${target.email}` };
    }

    const { randomUUID } = await import("crypto");
    const groupId = ownerLink?.group_id || targetLink?.group_id || randomUUID();

    // Add ticket customer to group as primary if not already linked
    if (!ownerLink) {
      await ctx.admin.from("customer_links").upsert({
        customer_id: ctx.customerId, workspace_id: ctx.workspaceId, group_id: groupId, is_primary: true,
      }, { onConflict: "customer_id" });
    }
    // Add target as non-primary
    await ctx.admin.from("customer_links").upsert({
      customer_id: target.id, workspace_id: ctx.workspaceId, group_id: groupId, is_primary: false,
    }, { onConflict: "customer_id" });

    const { addTicketTag } = await import("@/lib/ticket-tags");
    await addTicketTag(ctx.ticketId, "link");

    return { success: true, summary: `Linked ${target.email} to this account` };
  },

  // Close the ticket without sending a customer message. Use for
  // out-of-office auto-replies, bounce notifications, "vacation mode"
  // emails, and anything else where the inbound is automated/spam and
  // a reply would just bounce again. Pair with NO response_message —
  // the executor knows to skip sending when actions succeed AND no
  // response_message is set.
  // Subscribe a customer to email and/or SMS marketing via Shopify.
  // Optionally persists a phone number on the customer record first —
  // used when the customer types their number directly into chat
  // instead of filling the journey form. Eliminates the "kept asking
  // for the form, customer kept replying with their number" loop on
  // ticket 2876a0b1.
  //
  // Params:
  //   - code: phone number (E.164 or 10-digit; we'll normalize). If
  //     provided, set on customers.phone BEFORE subscribing.
  //   - reason: which channels — "email", "sms", or "both" (default).
  marketing_signup: async (ctx, p) => {
    const channelsParam = (p.reason || "both").toLowerCase();
    const wantEmail = channelsParam === "both" || channelsParam === "email";
    const wantSms = channelsParam === "both" || channelsParam === "sms";

    // Persist phone if passed and the customer doesn't already have one
    // that matches. Normalize: strip non-digits, prepend +1 if 10 digits.
    let phoneApplied: string | null = null;
    if (p.code) {
      const digits = String(p.code).replace(/\D/g, "");
      const normalized = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : `+${digits}`;
      const { data: existing } = await ctx.admin.from("customers")
        .select("phone").eq("id", ctx.customerId).single();
      if (!existing?.phone || existing.phone !== normalized) {
        await ctx.admin.from("customers")
          .update({ phone: normalized, updated_at: new Date().toISOString() })
          .eq("id", ctx.customerId);
      }
      phoneApplied = normalized;
    }

    const channels: ("email" | "sms")[] = [];
    if (wantEmail) channels.push("email");
    if (wantSms) channels.push("sms");
    if (channels.length === 0) return { success: false, error: "No channels selected" };

    const { subscribeToMarketing } = await import("@/lib/shopify-marketing");
    const result = await subscribeToMarketing(ctx.workspaceId, ctx.customerId, channels);

    const parts: string[] = [];
    if (phoneApplied) parts.push(`phone ${phoneApplied} saved`);
    if (wantEmail) parts.push("email subscribed");
    if (wantSms) parts.push("SMS subscribed");
    return {
      success: result.success,
      summary: parts.join(", "),
      error: result.error,
    };
  },

  close_ticket: async (ctx, p) => {
    await ctx.admin.from("tickets").update({
      status: "closed",
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", ctx.ticketId);
    ctx._closedThisRun = true;
    return { success: true, summary: `Closed ticket${p.reason ? ` — ${p.reason}` : ""}` };
  },

  // Persist a customer's free-text rejection of an account-linking suggestion.
  // Use when the customer explicitly says an unlinked candidate isn't theirs
  // (e.g. "that's not my email", "I don't have another account") so the
  // suggestion never re-fires on future tickets. Pair this with the
  // customer's actual ask in the same actions array — the rejection is a
  // bookkeeping step, not a stand-alone resolution.
  reject_account_link: async (ctx, p) => {
    if (!p.code) return { success: false, error: "Missing email (pass via 'code' param)" };
    const rejectedEmail = p.code.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rejectedEmail)) return { success: false, error: `Invalid email: ${rejectedEmail}` };

    const { data: target } = await ctx.admin.from("customers")
      .select("id").eq("workspace_id", ctx.workspaceId).ilike("email", rejectedEmail).maybeSingle();
    if (!target) return { success: false, error: `No customer profile found for ${rejectedEmail}` };
    if (target.id === ctx.customerId) return { success: false, error: "Cannot reject self-link" };

    await ctx.admin.from("customer_link_rejections").upsert({
      workspace_id: ctx.workspaceId,
      customer_id: ctx.customerId,
      rejected_customer_id: target.id,
    }, { onConflict: "customer_id,rejected_customer_id" });

    return { success: true, summary: `Rejected link suggestion for ${rejectedEmail} (won't re-suggest)` };
  },

  reactivate: async (ctx, p) => {
    const { appstleSubscriptionAction } = await import("@/lib/appstle");
    const r = await appstleSubscriptionAction(ctx.workspaceId, p.contract_id!, "resume");
    if (r.success) {
      const { addTicketTag } = await import("@/lib/ticket-tags");
      await addTicketTag(ctx.ticketId, "wb");
      await addTicketTag(ctx.ticketId, "wb:success");

      // Apply preserved base price if one exists (from crisis price fix)
      const { data: crisisAction } = await ctx.admin.from("crisis_customer_actions")
        .select("preserved_base_price_cents")
        .eq("subscription_id", p.contract_id!)
        .not("preserved_base_price_cents", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (crisisAction?.preserved_base_price_cents && p.variant_id) {
        const { subUpdateLineItemPrice } = await import("@/lib/subscription-items");
        await subUpdateLineItemPrice(ctx.workspaceId, p.contract_id!, p.variant_id, crisisAction.preserved_base_price_cents);
      }
    }
    return { ...r, summary: "Reactivated subscription" };
  },

  crisis_pause: async (ctx, p) => {
    const { appstleSubscriptionAction } = await import("@/lib/appstle");
    if (!p.contract_id) return { success: false, error: "Missing contract_id" };
    const r = await appstleSubscriptionAction(ctx.workspaceId, p.contract_id, "pause", "Crisis — customer requested pause until restock");
    if (r.success && p.crisis_action_id) {
      await ctx.admin.from("crisis_customer_actions").update({
        tier3_response: "accepted_pause", paused_at: new Date().toISOString(),
        auto_resume: true, exhausted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", p.crisis_action_id);
    }
    return { ...r, summary: "Paused subscription (will auto-resume when back in stock)" };
  },

  crisis_remove: async (ctx, p) => {
    const { subRemoveItem } = await import("@/lib/subscription-items");
    const r = await subRemoveItem(ctx.workspaceId, p.contract_id!, p.variant_id!);
    if (r.success && p.crisis_action_id) {
      await ctx.admin.from("crisis_customer_actions").update({
        tier3_response: "accepted_remove", removed_item_at: new Date().toISOString(),
        auto_readd: true, exhausted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", p.crisis_action_id);
    }
    return { ...r, summary: "Removed item (will auto-add when back in stock)" };
  },

  // Retroactively enroll a customer into an active crisis. Used when a
  // customer reports a "wrong item / wrong order" complaint and the
  // workspace has an active crisis whose swap variant matches what they
  // received. Sets auto_readd=true so when the crisis resolves the
  // customer's subscription gets switched back to their original item.
  crisis_enroll: async (ctx, p) => {
    const admin = ctx.admin;

    // 1. Find the active crisis (use param if provided, else first active)
    let crisis: {
      id: string;
      affected_variant_id: string | null;
      affected_sku: string | null;
      affected_product_title: string | null;
      default_swap_variant_id: string | null;
      default_swap_title: string | null;
    } | null = null;
    if (p.crisis_action_id) {
      // Param naming overload — Sonnet may pass crisis_id here
      const { data } = await admin.from("crisis_events")
        .select("id, affected_variant_id, affected_sku, affected_product_title, default_swap_variant_id, default_swap_title")
        .eq("id", p.crisis_action_id).maybeSingle();
      crisis = data;
    }
    if (!crisis) {
      const { data } = await admin.from("crisis_events")
        .select("id, affected_variant_id, affected_sku, affected_product_title, default_swap_variant_id, default_swap_title")
        .eq("workspace_id", ctx.workspaceId).eq("status", "active")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      crisis = data;
    }
    if (!crisis) return { success: false, error: "No active crisis found for workspace" };
    if (!crisis.affected_variant_id) return { success: false, error: "Crisis has no affected_variant_id" };

    // 2. Find the customer's subscription containing either the affected
    // variant (auto-swap hasn't run yet) or the swap variant (auto-swap
    // already applied — this is the common case for "wrong item" complaints)
    let subRow: { id: string; shopify_contract_id: string | null; items: unknown } | null = null;
    if (p.contract_id) {
      const { data } = await admin.from("subscriptions")
        .select("id, shopify_contract_id, items")
        .eq("workspace_id", ctx.workspaceId).eq("shopify_contract_id", p.contract_id)
        .maybeSingle();
      subRow = data;
    }
    if (!subRow) {
      const { data: subs } = await admin.from("subscriptions")
        .select("id, shopify_contract_id, items, status")
        .eq("workspace_id", ctx.workspaceId).eq("customer_id", ctx.customerId)
        .in("status", ["active", "paused"]);
      const matchVariants = new Set([crisis.affected_variant_id, crisis.default_swap_variant_id].filter(Boolean) as string[]);
      subRow = (subs || []).find(s =>
        ((s.items as { variant_id?: string; variantId?: string }[]) || []).some(i =>
          matchVariants.has(String(i.variant_id || i.variantId || ""))
        ),
      ) || null;
    }
    if (!subRow) return { success: false, error: "No subscription found containing the affected or swap variant" };

    // 3. Already enrolled? Don't double-enroll
    const { data: existing } = await admin.from("crisis_customer_actions")
      .select("id").eq("crisis_id", crisis.id).eq("subscription_id", subRow.id).maybeSingle();
    if (existing) return { success: true, summary: `Already enrolled in crisis (action ${existing.id})` };

    // 4. Determine segment + original item snapshot
    const items = (subRow.items as { variant_id?: string; variantId?: string; title?: string; sku?: string; quantity?: number }[]) || [];
    const affectedItem = items.find(i =>
      String(i.variant_id || i.variantId || "") === crisis.affected_variant_id ||
      String(i.variant_id || i.variantId || "") === crisis.default_swap_variant_id,
    );
    const otherItems = items.filter(i => i !== affectedItem);
    const segment = otherItems.length > 0 ? "berry_plus" : "berry_only";

    // original_item must point to the AFFECTED variant (not the swap) —
    // that's what auto_readd uses to swap back when crisis resolves.
    const originalItem = {
      variantId: crisis.affected_variant_id,
      sku: crisis.affected_sku || affectedItem?.sku || null,
      title: crisis.affected_product_title || affectedItem?.title || null,
      quantity: affectedItem?.quantity || 1,
    };

    // 5. Insert enrollment row. tier1_response='accepted_swap' marks this
    // as an after-the-fact enrollment — the swap already happened
    // physically. auto_readd=true is the critical bit: when the crisis is
    // marked resolved, the resolution job will switch the subscription
    // back to original_item.
    const nowIso = new Date().toISOString();
    const { data: inserted, error: insertErr } = await admin.from("crisis_customer_actions").insert({
      workspace_id: ctx.workspaceId,
      crisis_id: crisis.id,
      customer_id: ctx.customerId,
      subscription_id: subRow.id,
      segment,
      current_tier: 1,
      tier1_sent_at: nowIso,
      tier1_response: "accepted_swap",
      tier1_swapped_to: crisis.default_swap_variant_id ? {
        variantId: crisis.default_swap_variant_id,
        title: crisis.default_swap_title,
      } : null,
      original_item: originalItem,
      auto_readd: true,
    }).select("id").single();

    if (insertErr || !inserted) {
      return { success: false, error: `Failed to insert enrollment: ${insertErr?.message || "unknown"}` };
    }

    // 6. Tag the ticket so analytics + the next inbound message see crisis state
    const { addTicketTag } = await import("@/lib/ticket-tags");
    await addTicketTag(ctx.ticketId, "crisis");
    await addTicketTag(ctx.ticketId, `crisis:${crisis.id}`);

    return { success: true, summary: `Enrolled in crisis "${crisis.affected_product_title}" (auto_readd=true — will swap back to original on resolve)` };
  },

  // Flip auto_readd=true on an existing crisis_customer_actions row.
  // Used when a swap-accept customer (who chose "Keep <swap flavor>" at
  // tier1) later asks "will my original flavor come back automatically?"
  // — that question is a signal they're changing their mind. Sonnet
  // should call this in the same turn as the customer-facing promise so
  // the promise is backed by data, not fabrication. Surfaced on ticket
  // b0b2dee1 (Liz, May 6).
  crisis_set_auto_readd: async (ctx, p) => {
    const admin = ctx.admin;
    if (!ctx.customerId) return { success: false, error: "no customer on ticket" };

    // Find the most recent crisis_customer_actions row for this customer
    // (allow override via crisis_action_id param if Sonnet passed one).
    const targetId = p.crisis_action_id as string | undefined;
    let row: { id: string; auto_readd: boolean; original_item: Record<string, unknown> | null } | null = null;
    if (targetId) {
      const { data } = await admin.from("crisis_customer_actions")
        .select("id, auto_readd, original_item").eq("id", targetId).maybeSingle();
      row = data;
    } else {
      const { data } = await admin.from("crisis_customer_actions")
        .select("id, auto_readd, original_item")
        .eq("customer_id", ctx.customerId)
        .order("created_at", { ascending: false })
        .limit(1).maybeSingle();
      row = data;
    }
    if (!row) return { success: false, error: "no crisis_customer_actions row for this customer" };
    if (row.auto_readd) {
      return { success: true, summary: "auto_readd was already true — no change needed" };
    }

    await admin.from("crisis_customer_actions").update({
      auto_readd: true,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);

    const originalTitle = (row.original_item as { title?: string } | null)?.title || "the original item";
    return { success: true, summary: `Flipped auto_readd=true on crisis action — will switch back to ${originalTitle} when crisis resolves` };
  },

  /**
   * update_shipping_address — change the shipping address on an order
   * and/or subscription. Implements the full address-change logic tree:
   *
   *   • Order not yet in Amplifier (amplifier_order_id is null)
   *     → Shopify orderUpdate works; address is captured before
   *       Amplifier imports the order. Returns success.
   *
   *   • Order already in Amplifier
   *     → Amplifier exposes no update endpoint; the order will ship
   *       with the wrong address. Returns success: false with
   *       error: "in_amplifier" so Sonnet can ask the customer
   *       whether to send a replacement to the new address.
   *
   *   • Subscription contract — Appstle update endpoint works regardless
   *     of order state. Always succeeds when contract_id is provided.
   *
   *   • Customer profile default address — always written so future
   *     orders pick up the corrected address.
   *
   * Pass any subset:
   *   { order_number, contract_id, address }
   */
  update_shipping_address: async (ctx, p) => {
    const a = p.address;
    if (!a || !a.address1 || !a.city || !(a.province || a.state) || !(a.zip || a.postal_code)) {
      return { success: false, error: "address.address1, city, province (or state), and zip (or postal_code) are required" };
    }
    const province = (a.province || a.state || "").toUpperCase().slice(0, 2);
    const zip = a.zip || a.postal_code || "";
    const country = (a.country || a.country_code || "US").toUpperCase().slice(0, 2);

    const summaries: string[] = [];
    let anySuccess = false;
    let inAmplifier = false;

    // Order branch
    if (p.order_number || p.shopify_order_id) {
      const { data: order } = await ctx.admin.from("orders")
        .select("id, order_number, shopify_order_id, amplifier_order_id, amplifier_status")
        .eq("workspace_id", ctx.workspaceId)
        .or([
          p.order_number ? `order_number.eq.${p.order_number}` : "",
          p.shopify_order_id ? `shopify_order_id.eq.${p.shopify_order_id}` : "",
        ].filter(Boolean).join(","))
        .maybeSingle();
      if (!order) return { success: false, error: `Order not found: ${p.order_number || p.shopify_order_id}` };

      if (order.amplifier_order_id) {
        // Already in Amplifier — no update path. Caller (Sonnet) decides
        // whether to offer a replacement based on this signal.
        inAmplifier = true;
        summaries.push(`Order ${order.order_number} already in Amplifier (status: ${order.amplifier_status || "unknown"}); no update path`);
      } else if (order.shopify_order_id) {
        const { updateShippingAddress } = await import("@/lib/shopify-order-actions");
        const r = await updateShippingAddress(ctx.workspaceId, order.shopify_order_id, {
          address1: a.address1, address2: a.address2 || "",
          city: a.city, province, zip, country,
        });
        if (!r.success) return { success: false, error: `Shopify orderUpdate: ${r.error}` };
        // Sync local DB
        await ctx.admin.from("orders").update({
          shipping_address: {
            first_name: a.first_name, last_name: a.last_name, phone: a.phone,
            address1: a.address1, address2: a.address2 || null,
            city: a.city, province_code: province, zip, country_code: country,
          },
          updated_at: new Date().toISOString(),
        }).eq("id", order.id);
        anySuccess = true;
        summaries.push(`Shopify order ${order.order_number} updated`);
      }
    }

    // Subscription branch — Appstle endpoint
    if (p.contract_id) {
      try {
        const { healOnTouch } = await import("@/lib/appstle-pricing");
        await healOnTouch(ctx.workspaceId, String(p.contract_id));
        const { data: ws } = await ctx.admin.from("workspaces")
          .select("appstle_api_key_encrypted").eq("id", ctx.workspaceId).single();
        if (ws?.appstle_api_key_encrypted) {
          const { decrypt } = await import("@/lib/crypto");
          const apiKey = decrypt(ws.appstle_api_key_encrypted);
          const { loggedAppstleFetch } = await import("@/lib/appstle-call-log");
          const res = await loggedAppstleFetch(
            `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-shipping-address?contractId=${p.contract_id}`,
            {
              method: "PUT",
              headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
              // Appstle's GraphQL validation reads countryCode + provinceCode
              // specifically (the bare `country`/`province` fields aren't
              // wired to the SubscriptionDraftInput → deliveryMethod.shipping
              // path). Sending both keeps the REST shape happy while
              // satisfying the GraphQL validator. The portal handler sends
              // the same shape — keep them in sync.
              body: JSON.stringify({
                address1: a.address1, address2: a.address2 || "",
                city: a.city, zip,
                country, countryCode: country,
                province, provinceCode: province,
                firstName: a.first_name, lastName: a.last_name, phone: a.phone,
              }),
            },
            "update-shipping-address",
          );
          if (res.ok) {
            await ctx.admin.from("subscriptions").update({
              shipping_address: {
                first_name: a.first_name, last_name: a.last_name, phone: a.phone,
                address1: a.address1, address2: a.address2 || null,
                city: a.city, province_code: province, zip, country_code: country,
              },
              updated_at: new Date().toISOString(),
            }).eq("shopify_contract_id", p.contract_id);
            anySuccess = true;
            summaries.push(`Subscription ${p.contract_id} address updated`);
          } else {
            return { success: false, error: `Appstle ${res.status}` };
          }
        }
      } catch (err) {
        return { success: false, error: `Subscription update failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // Customer default address — always sync so future orders get it
    if (ctx.customerId) {
      await ctx.admin.from("customers").update({
        default_address: {
          first_name: a.first_name, last_name: a.last_name, phone: a.phone,
          address1: a.address1, address2: a.address2 || null,
          city: a.city, province_code: province, zip, country_code: country,
        },
        updated_at: new Date().toISOString(),
      }).eq("id", ctx.customerId);
      summaries.push("Customer default address synced");
    }

    if (inAmplifier && !anySuccess) {
      return { success: false, error: "in_amplifier", summary: summaries.join("; ") };
    }
    return { success: true, summary: summaries.join("; ") || "No changes" };
  },

  /**
   * update_customer_info — change any subset of the customer's
   * account contact fields (phone, email, first_name, last_name).
   * Distinct from update_shipping_address, which touches addresses
   * on orders/subs. This action lives on the customer profile.
   *
   * Behavior:
   *   - Validates phone (E.164 US) and email format up front.
   *   - Updates our customers row.
   *   - Pushes to Shopify via customerUpdate mutation so the
   *     customer's "My Account" reflects the change next time they
   *     log in.
   *   - Applies to the active customer only — does NOT cascade to
   *     linked profiles (that's a separate intent and the operator
   *     should confirm before touching multiple identities).
   *
   * Pass any subset of: { email, phone_number, first_name, last_name }.
   */
  update_customer_info: async (ctx, p) => {
    if (!ctx.customerId) return { success: false, error: "No customer in context" };
    const { toE164US, updateShopifyCustomer } = await import("@/lib/shopify-customer-update");

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    let phoneE164: string | undefined;
    if (p.phone_number) {
      const normalized = toE164US(p.phone_number);
      if (!normalized) {
        return { success: false, error: `Invalid phone "${p.phone_number}" — need 10 digits` };
      }
      phoneE164 = normalized;
      updates.phone = phoneE164;
    }
    if (p.email != null) {
      const email = p.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { success: false, error: `Invalid email "${p.email}"` };
      }
      updates.email = email;
    }
    if (p.first_name != null) updates.first_name = p.first_name.trim();
    if (p.last_name != null) updates.last_name = p.last_name.trim();

    if (Object.keys(updates).length <= 1) {
      return { success: false, error: "No fields to update" };
    }

    // Pull the Shopify ID before we mutate locally so we can hand off.
    const { data: cust } = await ctx.admin.from("customers")
      .select("shopify_customer_id")
      .eq("id", ctx.customerId)
      .single();

    // Local DB write first — it's the source of truth for the
    // dashboard. If Shopify rejects we can show the local update
    // succeeded but flag that Shopify is out of sync.
    const { error: dbErr } = await ctx.admin
      .from("customers")
      .update(updates)
      .eq("id", ctx.customerId);
    if (dbErr) return { success: false, error: `DB update failed: ${dbErr.message}` };

    const changed: string[] = [];
    if (phoneE164) changed.push("phone");
    if (updates.email) changed.push("email");
    if (updates.first_name != null) changed.push("first name");
    if (updates.last_name != null) changed.push("last name");

    // Shopify push
    let shopifyNote = "";
    if (cust?.shopify_customer_id) {
      const r = await updateShopifyCustomer({
        workspaceId: ctx.workspaceId,
        shopifyCustomerId: cust.shopify_customer_id as string,
        phone: phoneE164,
        email: (updates.email as string) || undefined,
        firstName: updates.first_name as string | undefined,
        lastName: updates.last_name as string | undefined,
      });
      if (r.success) {
        shopifyNote = " (synced to Shopify)";
      } else {
        // Local update stands; flag the sync gap so an operator can
        // reconcile manually. Common cause: another customer in the
        // same shop already owns this email/phone.
        shopifyNote = ` (Shopify rejected: ${r.error})`;
      }
    } else {
      shopifyNote = " (no Shopify ID on record)";
    }

    return {
      success: true,
      summary: `Updated ${changed.join(", ")} on customer profile${shopifyNote}`,
    };
  },

  /**
   * switch_payment_method — set a specific card as the active payment
   * method on one (or all) of the customer's active subscriptions.
   * Identified by last4 since that's what the customer cites in chat.
   *
   * Reuses the dunning-system helper appstleSwitchPaymentMethod, which
   * already handles BOTH internal (Braintree-vaulted) subs AND legacy
   * Appstle/Shopify-Payments subs — for Appstle ones it calls
   * subscription-contracts-update-existing-payment-method.
   *
   * Pass:
   *   - card_last4 (required) — e.g. "8924"
   *   - contract_id (optional) — limit to one sub; defaults to ALL
   *     active subs on the customer.
   *
   * Returns success: false if no card matches the last4, or if the
   * customer has multiple cards ending in the same digits (ambiguous —
   * needs more disambiguation from the customer).
   */
  switch_payment_method: async (ctx, p) => {
    if (!p.card_last4) return { success: false, error: "card_last4 required" };
    const last4 = p.card_last4.replace(/\D/g, "").slice(-4);
    if (last4.length !== 4) return { success: false, error: `card_last4 must be 4 digits, got "${p.card_last4}"` };

    // Pull the customer's Shopify ID + linked accounts so we cover all
    // active subs across the link group.
    const { data: cust } = await ctx.admin.from("customers")
      .select("shopify_customer_id").eq("id", ctx.customerId).single();
    if (!cust?.shopify_customer_id) return { success: false, error: "No Shopify customer ID on record" };

    // Match by last4 against Shopify payment methods (active only).
    const { getCustomerPaymentMethods } = await import("@/lib/dunning");
    const cards = await getCustomerPaymentMethods(ctx.workspaceId, cust.shopify_customer_id as string);
    const matches = cards.filter((c) => c.last4 === last4);
    if (matches.length === 0) {
      return { success: false, error: `No active card ending in ${last4} on file. Cards on file: ${cards.map((c) => `*${c.last4}`).join(", ") || "(none)"}` };
    }
    if (matches.length > 1) {
      // Disambiguate by expiry — if the customer mentioned brand or
      // expiry we'd extend the param shape; for now just refuse and
      // surface the duplicates so Sonnet asks the customer.
      return { success: false, error: `Multiple active cards end in ${last4}: ${matches.map((c) => `${c.brand} exp ${c.expiryMonth}/${c.expiryYear}`).join("; ")}. Ask the customer which one.` };
    }
    const card = matches[0];

    // Resolve which subs to update.
    const ids = await (async () => {
      const { data: link } = await ctx.admin.from("customer_links")
        .select("group_id").eq("customer_id", ctx.customerId).maybeSingle();
      if (!link?.group_id) return [ctx.customerId];
      const { data: g } = await ctx.admin.from("customer_links")
        .select("customer_id").eq("group_id", link.group_id);
      return (g || []).map((r) => r.customer_id as string);
    })();

    let subQuery = ctx.admin.from("subscriptions")
      .select("shopify_contract_id, items, status")
      .in("customer_id", ids)
      .eq("status", "active");
    if (p.contract_id) subQuery = subQuery.eq("shopify_contract_id", p.contract_id);
    const { data: subs } = await subQuery;
    if (!subs || subs.length === 0) {
      return { success: false, error: p.contract_id ? `Subscription ${p.contract_id} not found or not active` : "Customer has no active subscriptions to update" };
    }

    // Loop the switch across each active sub.
    const { appstleSwitchPaymentMethod } = await import("@/lib/appstle");
    const summaries: string[] = [];
    const failures: string[] = [];
    for (const sub of subs) {
      const r = await appstleSwitchPaymentMethod(ctx.workspaceId, sub.shopify_contract_id as string, card.id);
      if (r.success) {
        summaries.push(sub.shopify_contract_id as string);
      } else {
        failures.push(`${sub.shopify_contract_id}: ${r.error}`);
      }
    }

    if (summaries.length === 0) {
      return { success: false, error: `All updates failed. ${failures.join("; ")}` };
    }
    const summary = `Switched ${summaries.length} subscription${summaries.length > 1 ? "s" : ""} to ${card.brand || "card"} ending ${card.last4}${failures.length ? ` (${failures.length} failed: ${failures.join("; ")})` : ""}`;
    return { success: true, summary };
  },

  create_replacement_order: async (ctx, p) => {
    // Get customer's Shopify ID
    const { data: cust } = await ctx.admin.from("customers")
      .select("shopify_customer_id").eq("id", ctx.customerId).single();
    if (!cust?.shopify_customer_id) return { success: false, error: "No Shopify customer ID" };

    // Resolve shipping address — explicit override wins (used when the
    // original order is in Amplifier with a wrong address; we ship the
    // replacement to a different address). Otherwise: order match →
    // any subscription → most recent order. The original code only
    // looked at active subs, which broke replacements for one-time
    // customers and anyone with paused/cancelled subs.
    let addr: Record<string, string> = {};
    if (p.address?.address1) {
      const a = p.address;
      addr = {
        firstName: a.first_name || "",
        lastName: a.last_name || "",
        address1: a.address1 || "",
        address2: a.address2 || "",
        city: a.city || "",
        provinceCode: (a.province || a.state || "").toUpperCase().slice(0, 2),
        zip: a.zip || a.postal_code || "",
        countryCode: (a.country || a.country_code || "US").toUpperCase().slice(0, 2),
      };
    }
    if (!addr.address1 && p.order_number) {
      const { data: order } = await ctx.admin.from("orders")
        .select("shipping_address")
        .eq("workspace_id", ctx.workspaceId)
        .eq("order_number", p.order_number)
        .maybeSingle();
      if (order?.shipping_address) addr = order.shipping_address as Record<string, string>;
    }
    if (!addr.address1) {
      const { data: subs } = await ctx.admin.from("subscriptions")
        .select("shipping_address, status")
        .eq("customer_id", ctx.customerId)
        .order("status", { ascending: true })
        .limit(5);
      for (const s of subs || []) {
        const sa = s.shipping_address as Record<string, string> | null;
        if (sa?.address1) { addr = sa; break; }
      }
    }
    if (!addr.address1) {
      const { data: orders } = await ctx.admin.from("orders")
        .select("shipping_address")
        .eq("customer_id", ctx.customerId)
        .order("created_at", { ascending: false })
        .limit(5);
      for (const o of orders || []) {
        const oa = o.shipping_address as Record<string, string> | null;
        if (oa?.address1) { addr = oa; break; }
      }
    }
    if (!addr.address1) return { success: false, error: "No shipping address found on any subscription or order" };

    const variantId = p.variant_id || "42614433513645"; // fallback variant (Peach Mango)
    const quantity = p.quantity || 1;

    // Resolve variant title for the summary string. Without this the
    // summary always claimed "Peach Mango" regardless of what variant_id
    // Sonnet actually passed — surfaced on ticket ffd28680 (Dean, May 7)
    // where Strawberry Lemonade shipped correctly but the analyzer was
    // misled by a "2x Peach Mango shipped free" log line.
    let variantTitle = "item";
    try {
      const { data: pv } = await ctx.admin.from("product_variants")
        .select("title, products(title)")
        .eq("shopify_variant_id", variantId).maybeSingle();
      if (pv) {
        const productTitle = (pv.products as { title?: string } | null)?.title;
        variantTitle = pv.title && productTitle ? `${productTitle} (${pv.title})` : (pv.title || productTitle || "item");
      }
    } catch { /* fall back to "item" */ }

    // Delegate to the canonical helper. It records-first into `replacements`,
    // then creates the Shopify draft + completes it, and stamps the row
    // with the final state. Any caller using this helper guarantees a
    // replacements row exists for every Shopify replacement order.
    const { createReplacementOrder } = await import("@/lib/replacement-order");
    const r = await createReplacementOrder({
      workspaceId: ctx.workspaceId,
      customerId: ctx.customerId,
      shopifyCustomerId: cust.shopify_customer_id,
      items: [{ variantId, quantity, title: variantTitle }],
      shippingAddress: {
        firstName: addr.firstName || addr.first_name || "",
        lastName: addr.lastName || addr.last_name || "",
        address1: addr.address1 || "",
        address2: addr.address2 || "",
        city: addr.city || "",
        province: addr.province || "",
        provinceCode: addr.provinceCode || addr.province_code || addr.province || "",
        zip: addr.zip || "",
        countryCode: "US",
      },
      reason: (p.reason as string) || "damaged_items",
      originalOrderNumber: p.order_number || null,
      ticketId: ctx.ticketId || null,
      shopifyNote: "Replacement order — crisis swap compensation",
      initiatedBy: "ai",
    });

    if (!r.success) return { success: false, error: r.error || "replacement creation failed" };
    return { success: true, summary: `Replacement order ${r.shopifyOrderName || "created"} — ${quantity}x ${variantTitle} shipped free` };
  },
};

async function notifySlack(ctx: ActionContext, p: ActionParams, amountDecimal: string): Promise<void> {
  try {
    const { dispatchSlackNotification } = await import("@/lib/slack-notify");
    const { data: cust } = await ctx.admin.from("customers").select("email, first_name, last_name").eq("id", ctx.customerId).single();
    const custName = [cust?.first_name, cust?.last_name].filter(Boolean).join(" ");
    await dispatchSlackNotification(ctx.workspaceId, "partial_refund", {
      ticketId: ctx.ticketId,
      customer: { name: custName, email: cust?.email || "" },
      amount: amountDecimal,
      reason: p.reason || "price adjustment",
      orderNumber: p.shopify_order_id || "",
    });
  } catch { /* non-fatal */ }
}

// ── Main Executor ──

export async function executeSonnetDecision(
  ctx: ActionContext,
  decision: SonnetDecision,
  personality: { name?: string; tone?: string; sign_off?: string | null } | null,
  send: SendFn,
  sysNote: SysNoteFn,
): Promise<{ messageSent: boolean; escalated: boolean; closed: boolean; statusManaged: boolean }> {
  // Handle clarification first — applies regardless of action_type
  if (decision.needs_clarification && decision.clarification_question) {
    await send(decision.clarification_question, ctx.sandbox);
    return { messageSent: true, escalated: false, closed: false, statusManaged: false };
  }

  // Track whether a customer-facing message was sent
  let messageSent = false;
  // Track whether a sub-executor already set the authoritative final
  // ticket status (e.g. the workflow executor closes account_login and
  // leaves return_to_sender open). When true the post-execute status
  // block in unified-ticket-handler must NOT override it.
  let statusManaged = false;
  const trackedSend: SendFn = async (m, sb) => { messageSent = true; await send(m, sb); };

  switch (decision.action_type) {
    case "direct_action":
      await handleDirectAction(ctx, decision, trackedSend, sysNote);
      break;

    case "journey":
      await handleJourney(ctx, decision, trackedSend, sysNote);
      // Journey delivery sends its own messages — mark as sent so the
      // ticket doesn't stay open with "no customer message sent"
      messageSent = true;
      break;

    case "playbook":
      await handlePlaybook(ctx, decision, personality, trackedSend, sysNote);
      break;

    case "workflow":
      // The workflow executor sets the authoritative final status itself
      // (sendReply: closed for account_login, open for return_to_sender).
      // Signal statusManaged so the post-execute block doesn't reopen a
      // legitimately-closed ticket (Mindy Freeman a89dcf76: magic-link
      // sent + closed, then orchestrator reopened it as "no message sent").
      statusManaged = await handleWorkflow(ctx, decision, send, sysNote);
      break;

    case "macro":
      await handleMacro(ctx, decision, trackedSend);
      break;

    case "kb_response":
    case "ai_response":
      if (decision.response_message) {
        await trackedSend(decision.response_message, ctx.sandbox);
      }
      // On agent-involved tickets the orchestrator is constrained to
      // either a positive closure or a "we're reviewing your ticket and
      // an agent will be back with you shortly" holding response. Both
      // come through as ai_response. A positive closure sets
      // _closedThisRun via the close_ticket action; if we got here
      // WITHOUT that flag, this is a holding promise — flip escalation
      // state so the assigned agent gets a real signal in the queue
      // instead of the ticket silently auto-closing under them.
      // (Suzanne Doucet 2026-05-21: AI said "agent will be back",
      // then post-execute auto-close closed the ticket and the agent
      // never knew she was waiting. Lost for a week.)
      if (ctx.agentInvolved && !ctx._closedThisRun && !ctx._escalatedThisRun) {
        await escalateTicket(ctx, "ai_holding_promise");
      }
      break;

    case "escalate":
      await handleEscalate(ctx, decision, trackedSend, sysNote);
      break;

    default:
      await sysNote(`Unknown action_type: ${decision.action_type}`);
  }

  return {
    messageSent,
    escalated: ctx._escalatedThisRun === true,
    closed: ctx._closedThisRun === true,
    statusManaged,
  };
}

// ── Handler: Direct Actions ──

async function handleDirectAction(
  ctx: ActionContext,
  decision: SonnetDecision,
  send: SendFn,
  sysNote: SysNoteFn,
): Promise<void> {
  const actions = decision.actions || [];

  if (actions.length === 0) {
    await sysNote("Sonnet returned direct_action with no actions.");
    return;
  }

  // Sandbox mode: log what would happen without executing
  if (ctx.sandbox) {
    const descriptions = actions.map(
      (a) => `[sandbox] Would execute: ${a.type} (${JSON.stringify(a)})`,
    );
    for (const desc of descriptions) {
      await sysNote(desc);
    }
    if (decision.response_message) {
      await send(decision.response_message, true);
    }
    return;
  }

  // Resolve contract IDs — Sonnet might return UUIDs instead of Shopify contract IDs
  for (const action of actions) {
    if (action.contract_id && action.contract_id.includes("-")) {
      // Looks like a UUID — resolve to Shopify contract ID
      const { data: sub } = await ctx.admin.from("subscriptions")
        .select("shopify_contract_id")
        .eq("id", action.contract_id)
        .maybeSingle();
      if (sub?.shopify_contract_id) {
        action.contract_id = sub.shopify_contract_id;
      } else {
        await sysNote(`Warning: could not resolve subscription UUID ${action.contract_id} to Shopify contract ID`);
      }
    }
  }

  // Execute each action and collect results
  const results: { action: ActionParams; result: ActionResult }[] = [];

  // Per-action call logging — wrap each handler in an AsyncLocalStorage
  // context so any Appstle fetch deep in the call chain auto-logs its
  // request/response back to appstle_api_calls with the ticket reference.
  const { withActionContext } = await import("@/lib/appstle-call-log");

  for (const action of actions) {
    const handler = directActionHandlers[action.type];
    if (!handler) {
      results.push({
        action,
        result: { success: false, error: `Unknown action type: ${action.type}` },
      });
      continue;
    }

    // Substitute placeholders in this action's string params using
    // results from prior actions in this same turn. The classic case:
    // Sonnet emits actions=[redeem_points, apply_loyalty_coupon{code:
    // "{{coupon_code}}"}]. The previous code substituted placeholders
    // in the response message only, so apply_loyalty_coupon ran with
    // the literal "{{coupon_code}}" string and Appstle returned
    // DISCOUNT_NOT_FOUND. Caught on Becky's ticket 6ab4b02d (May 16).
    const substituted = substituteActionParams(action, results);

    try {
      const result = await withActionContext(
        {
          workspaceId: ctx.workspaceId,
          ticketId: ctx.ticketId,
          customerId: ctx.customerId,
          actionType: action.type,
        },
        () => handler(ctx, substituted),
      );
      results.push({ action: substituted, result });
    } catch (err) {
      results.push({
        action: substituted,
        result: { success: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  const failures = results.filter((r) => !r.result.success);
  const successes = results.filter((r) => r.result.success);

  // Log summaries as system notes
  for (const s of successes) {
    await sysNote(`Action completed: ${s.result.summary || s.action.type}`);
  }
  for (const f of failures) {
    await sysNote(`Action failed: ${f.action.type} — ${f.result.error}`);
  }

  if (failures.length === 0) {
    // Self-heal: verify each action actually took effect BEFORE we send
    // the AI's prefab "I did it" message. Earlier flow sent the message
    // optimistically and then verified — the customer would see a fake
    // success even when the action silently didn't stick.
    await new Promise(resolve => setTimeout(resolve, 3000));
    const verifyFailures: string[] = [];

    // Refunds are NOT idempotent — re-running one double-refunds the customer.
    // They're also confirmed by their own handler (Braintree refund id / polled
    // Shopify gateway status), and their DB verification (Shopify financial_status)
    // is unreliable for Braintree-direct refunds, which never flip it. So never
    // self-heal-retry a refund. (Sonia Stevens: a settled $179.88 Braintree refund
    // couldn't be confirmed via financial_status, the retry tried to refund AGAIN,
    // hit "amount too large", and falsely escalated a refund that had succeeded.)
    const NO_SELF_HEAL_RETRY = new Set(["partial_refund", "redeem_points_as_refund"]);

    for (const s of successes) {
      if (NO_SELF_HEAL_RETRY.has(s.action.type)) continue;
      const verified = await verifyActionInDB(ctx, s.action);
      if (!verified) {
        const { addTicketTag } = await import("@/lib/ticket-tags");
        await addTicketTag(ctx.ticketId, "ai:fix");
        await sysNote(`[Self-heal] Verification failed for ${s.action.type} — retrying...`);

        const handler = directActionHandlers[s.action.type];
        if (handler) {
          try {
            const retryResult = await handler(ctx, s.action);
            if (retryResult.success) {
              await sysNote(`[Self-heal] Retried ${s.action.type} — succeeded on retry.`);
              await addTicketTag(ctx.ticketId, "ai:fix-success");
            } else {
              verifyFailures.push(`${s.action.type}: retry failed — ${retryResult.error}`);
            }
          } catch (err) {
            verifyFailures.push(`${s.action.type}: retry threw — ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          verifyFailures.push(`${s.action.type}: verification failed, no handler for retry`);
        }
      }
    }

    // Send the customer-facing confirmation only AFTER verify+retry have
    // resolved cleanly. If verify still failed, fall through to the
    // verify-failure escalation block below — no response_message goes out.
    if (verifyFailures.length === 0 && decision.response_message) {
      const filled = substituteActionPlaceholders(decision.response_message, results);
      await send(filled, ctx.sandbox);
    }

    if (verifyFailures.length > 0) {
      const { addTicketTag } = await import("@/lib/ticket-tags");
      await addTicketTag(ctx.ticketId, "ai:fix");
      await addTicketTag(ctx.ticketId, "ai:fix-fail");
      for (const f of verifyFailures) {
        await sysNote(`[Self-heal] Action verification failed: ${f}`);
      }
      await send(
        "I ran into a small issue completing one of the changes to your account. Don't worry — our team is on it and we'll send you a follow-up message once everything is confirmed.",
        ctx.sandbox,
      );
      await escalateTicket(ctx, `Self-heal verification failures: ${verifyFailures.join("; ")}`);
    }
  } else {
    // Some failed — escalate with a human-sounding holding message.
    // Avoid "I ran into an issue" / "I'll look into it" wording —
    // those read as AI-speak and undermine trust. The pre-authored
    // response_message is intentionally NOT sent here, since it
    // typically claims success that didn't happen.
    const errorMsg =
      "Someone on my team is working on this and we'll get back to you shortly!";
    await send(errorMsg, ctx.sandbox);
    await escalateTicket(ctx, `Direct action failures: ${failures.map((f) => `${f.action.type}: ${f.result.error}`).join("; ")}`);
  }
}

/**
 * Verify that a direct action's expected state change is reflected in the DB.
 * Returns true if verified, false if the expected state wasn't found.
 */
async function verifyActionInDB(
  ctx: ActionContext,
  action: ActionParams,
): Promise<boolean> {
  const admin = ctx.admin;

  switch (action.type) {
    case "cancel": {
      if (!action.contract_id) return true;
      const { data } = await admin.from("subscriptions")
        .select("status").eq("shopify_contract_id", action.contract_id).single();
      return data?.status === "cancelled";
    }
    case "pause":
    case "crisis_pause": {
      if (!action.contract_id) return true;
      const { data } = await admin.from("subscriptions")
        .select("status").eq("shopify_contract_id", action.contract_id).single();
      return data?.status === "paused";
    }
    case "resume":
    case "reactivate": {
      if (!action.contract_id) return true;
      const { data } = await admin.from("subscriptions")
        .select("status").eq("shopify_contract_id", action.contract_id).single();
      return data?.status === "active";
    }
    case "partial_refund":
    case "redeem_points_as_refund": {
      // Check if order financial_status changed
      if (!action.shopify_order_id) return true;
      const { data } = await admin.from("orders")
        .select("financial_status").eq("shopify_order_id", action.shopify_order_id).single();
      return data?.financial_status === "partially_refunded" || data?.financial_status === "refunded";
    }
    case "pause_timed": {
      if (!action.contract_id) return true;
      const { data } = await admin.from("subscriptions")
        .select("status").eq("shopify_contract_id", action.contract_id).single();
      return data?.status === "paused";
    }
    case "apply_coupon":
    case "apply_loyalty_coupon": {
      if (!action.contract_id || !action.code) return true;
      const { data } = await admin.from("subscriptions")
        .select("applied_discounts").eq("shopify_contract_id", action.contract_id).single();
      const discounts = (data?.applied_discounts || []) as { title?: string }[];
      return discounts.some(d => d.title === action.code);
    }
    default:
      // No verification logic for this action type — assume OK
      return true;
  }
}

// ── Handler: Journey ──

async function handleJourney(
  ctx: ActionContext,
  decision: SonnetDecision,
  send: SendFn,
  sysNote: SysNoteFn,
): Promise<void> {
  if (!decision.handler_name) {
    await sysNote("Journey action missing handler_name.");
    return;
  }

  // Look up journey by name OR trigger_intent (Sonnet may return either)
  const handlerName = decision.handler_name!;
  let { data: journey } = await ctx.admin
    .from("journey_definitions")
    .select("id, name, trigger_intent")
    .eq("workspace_id", ctx.workspaceId)
    .eq("is_active", true)
    .or(`name.eq.${handlerName},trigger_intent.eq.${handlerName}`)
    .limit(1)
    .single();

  // Fallback: case-insensitive AND space↔underscore-tolerant match. The
  // model commonly snake-cases handler names ("Cancel Subscription" →
  // "cancel_subscription") which wouldn't otherwise match.
  if (!journey) {
    const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "_").trim();
    const target = norm(handlerName);
    const { data: all } = await ctx.admin
      .from("journey_definitions")
      .select("id, name, trigger_intent")
      .eq("workspace_id", ctx.workspaceId)
      .eq("is_active", true);
    journey = (all || []).find(j =>
      norm(j.name) === target ||
      (j.trigger_intent && norm(j.trigger_intent) === target)
    ) || null;
  }

  if (!journey) {
    // Don't leave the customer hanging — escalate to an agent so the
    // ticket lands in someone's queue with context. The model often
    // gets the handler name slightly wrong; this is the safety net.
    const reason = `Journey not found: "${decision.handler_name}". Sonnet's intent was: ${decision.reasoning || "unknown"}`;
    await sysNote(reason);
    await escalateTicket(ctx, reason);
    const safeMsg = stripUnsubstitutedPlaceholders(decision.response_message || "I need a little time to work on this and I'll get back to you.");
    await send(safeMsg, ctx.sandbox);
    return;
  }

  // Resolve subscription_id from any of the actions Sonnet emitted that
  // reference a contract (pause, skip, etc.). Sonnet emits the Shopify
  // contract id in `contract_id`; we need our internal subscription UUID
  // for the journey_session row. If Sonnet didn't reference a contract,
  // pass null and the mini-site picker handles the choice.
  //
  // CANCEL is deliberately excluded: the cancel journey is code-driven and
  // owns subscription selection (picker when >1 sub, auto when exactly 1 —
  // see cancel-journey-builder.ts). Pre-binding here would SKIP that picker
  // (journey route.ts:82), and `find(a => a.contract_id)` grabs the FIRST
  // contract from ANY action — including a side action on a DIFFERENT sub
  // (e.g. a remove_item alongside the cancel). That mis-bound Jodi's cancel
  // to the wrong subscription and silently ran the flow against it
  // (ticket 178ae5a7). Never let the AI preconfigure the cancel target.
  const isCancelJourney = ["cancel", "cancel_subscription", "cancellation"]
    .includes((journey.trigger_intent || "").toLowerCase());
  let subscriptionId: string | undefined;
  const contractId = isCancelJourney
    ? undefined
    : decision.actions?.find(a => a.contract_id)?.contract_id;
  if (contractId) {
    const { data: sub } = await ctx.admin.from("subscriptions")
      .select("id").eq("workspace_id", ctx.workspaceId)
      .eq("shopify_contract_id", contractId).maybeSingle();
    if (sub?.id) subscriptionId = sub.id;
  }

  // Fire any non-routing direct actions Sonnet emitted in actions[] —
  // e.g. "create_return on SC131156" alongside an action_type=journey
  // routing to cancel_subscription. The journey's leadIn then uses
  // placeholder substitution from those results so the customer sees the
  // label CTA in the same message as the cancel CTA.
  //
  // We skip actions that ARE the journey routing itself (handled by the
  // journey launcher's own action layer).
  const JOURNEY_ROUTING_TYPES = new Set(["cancel", "cancel_subscription", "pause", "skip_next_order"]);
  const sideActions = (decision.actions || []).filter(a => !JOURNEY_ROUTING_TYPES.has(a.type));
  let leadIn = decision.response_message || "";
  if (sideActions.length && !ctx.sandbox) {
    const results = await executeActionsInline(ctx, sideActions, sysNote);
    leadIn = substituteActionPlaceholders(leadIn, results);
  } else {
    // No actions fired — strip any unsubstituted placeholders so we
    // never send literal `{{label_url}}` to the customer.
    leadIn = stripUnsubstitutedPlaceholders(leadIn);
  }

  const { launchJourneyForTicket } = await import("@/lib/journey-delivery");
  const launched = await launchJourneyForTicket({
    workspaceId: ctx.workspaceId,
    ticketId: ctx.ticketId,
    customerId: ctx.customerId,
    journeyId: journey.id,
    journeyName: journey.name,
    triggerIntent: journey.trigger_intent,
    channel: ctx.channel,
    leadIn,
    ctaText: journey.name,
    subscriptionId,
  });

  if (!launched) {
    await sysNote(`Journey could not be launched on channel: ${ctx.channel}`);
    // Fall back to sending the (already-substituted, already-stripped) leadIn directly
    if (leadIn) await send(leadIn, ctx.sandbox);
  }
}

// ── Handler: Playbook ──

async function handlePlaybook(
  ctx: ActionContext,
  decision: SonnetDecision,
  personality: { name?: string; tone?: string; sign_off?: string | null } | null,
  send: SendFn,
  sysNote: SysNoteFn,
): Promise<void> {
  if (!decision.handler_name) {
    await sysNote("Playbook action missing handler_name.");
    return;
  }

  // Look up playbook by name or trigger_intents — case-insensitive AND
  // tolerant of space↔underscore swaps. The model frequently snake-cases
  // a handler ("Replacement Order" → "replacement_order") that wouldn't
  // otherwise match. Normalize both sides before comparing.
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "_").trim();
  const pbName = decision.handler_name!;
  const target = norm(pbName);
  const { data: allPlaybooks } = await ctx.admin
    .from("playbooks")
    .select("id, name, trigger_intents")
    .eq("workspace_id", ctx.workspaceId)
    .eq("is_active", true);
  const playbook = (allPlaybooks || []).find(p =>
    norm(p.name) === target ||
    ((p.trigger_intents as string[]) || []).some(i => norm(i) === target)
  ) || null;

  if (!playbook) {
    // Cross-check: did the model mis-classify a JOURNEY as a playbook?
    // ("Cancel Subscription" is a journey, but Opus has been seen picking
    // action_type=playbook for it.) If a matching journey exists, route
    // there instead of escalating with raw placeholders in the message.
    const { data: allJourneys } = await ctx.admin
      .from("journey_definitions")
      .select("id, name, trigger_intent")
      .eq("workspace_id", ctx.workspaceId)
      .eq("is_active", true);
    const matchedJourney = (allJourneys || []).find(j =>
      norm(j.name) === target ||
      (j.trigger_intent && norm(j.trigger_intent) === target)
    ) || null;

    if (matchedJourney) {
      await sysNote(`Playbook lookup miss for "${decision.handler_name}" — but matching journey "${matchedJourney.name}" found. Routing to journey.`);
      const reroute: SonnetDecision = { ...decision, action_type: "journey" };
      await handleJourney(ctx, reroute, send, sysNote);
      return;
    }

    const reason = `Playbook not found: "${decision.handler_name}". Sonnet's intent was: ${decision.reasoning || "unknown"}`;
    await sysNote(reason);
    await escalateTicket(ctx, reason);
    const safeMsg = stripUnsubstitutedPlaceholders(decision.response_message || "I need a little time to work on this and I'll get back to you.");
    await send(safeMsg, ctx.sandbox);
    return;
  }

  const { startPlaybook, executePlaybookStep } = await import("@/lib/playbook-executor");

  // Check if this playbook is already active on the ticket (continuation vs new)
  const { data: ticketState } = await ctx.admin.from("tickets")
    .select("active_playbook_id").eq("id", ctx.ticketId).single();

  if (ticketState?.active_playbook_id === playbook.id) {
    // Continuing active playbook — execute next step with the customer's message
    const lastMsg = await ctx.admin.from("ticket_messages")
      .select("body_clean, body")
      .eq("ticket_id", ctx.ticketId).eq("direction", "inbound").eq("author_type", "customer")
      .order("created_at", { ascending: false }).limit(1).single();
    const customerMsg = lastMsg?.data?.body_clean || lastMsg?.data?.body || "";

    let result = await executePlaybookStep(ctx.workspaceId, ctx.ticketId, customerMsg, personality);
    if (result.systemNote) await sysNote(result.systemNote);
    if (result.response) { await send(result.response, ctx.sandbox); return; }

    // Auto-advance: keep executing steps until one sends a response or completes
    let advances = 0;
    while (result.action === "advance" && advances < 10) {
      advances++;
      result = await executePlaybookStep(ctx.workspaceId, ctx.ticketId, customerMsg, personality);
      if (result.systemNote) await sysNote(result.systemNote);
      if (result.response) { await send(result.response, ctx.sandbox); return; }
      if (result.action === "complete") break;
    }
  } else {
    // Starting new playbook. Pass the customer's last inbound message
    // so the playbook can use it for order identification, intent
    // detection, etc. Previously this was hardcoded to "" which meant
    // the order-number/product-name/date matchers had nothing to work
    // with — even when the customer typed the order number AND named
    // the product in their first sentence (ticket 36f7664d: "order
    // SC129467 The creamer I bought…" → playbook still asked which
    // order, because msg was empty).
    const lastMsg = await ctx.admin.from("ticket_messages")
      .select("body_clean, body")
      .eq("ticket_id", ctx.ticketId).eq("direction", "inbound").eq("author_type", "customer")
      .order("created_at", { ascending: false }).limit(1).single();
    const customerMsg = lastMsg?.data?.body_clean || lastMsg?.data?.body || "";

    await startPlaybook(ctx.admin, ctx.ticketId, playbook.id);

    let result = await executePlaybookStep(
      ctx.workspaceId, ctx.ticketId, customerMsg, personality,
    );

    if (result.systemNote) await sysNote(result.systemNote);
    if (result.response) { await send(result.response, ctx.sandbox); return; }

    let advances = 0;
    while (result.action === "advance" && advances < 10) {
      advances++;
      result = await executePlaybookStep(ctx.workspaceId, ctx.ticketId, customerMsg, personality);
      if (result.systemNote) await sysNote(result.systemNote);
      if (result.response) { await send(result.response, ctx.sandbox); return; }
      if (result.action === "complete") break;
    }
  }
}

// ── Handler: Workflow ──

// Returns true when a workflow actually ran — the workflow executor sets
// the authoritative ticket status (closed/open) inside executeWorkflow, so
// the caller must treat the status as managed and not override it. Returns
// false on the failure paths (missing handler_name, or workflow-not-found
// which escalates instead), where the normal post-execute logic applies.
async function handleWorkflow(
  ctx: ActionContext,
  decision: SonnetDecision,
  send: SendFn,
  sysNote: SysNoteFn,
): Promise<boolean> {
  if (!decision.handler_name) {
    await sysNote("Workflow action missing handler_name.");
    return false;
  }

  // Look up workflow by name, trigger_tag, or template — case-insensitive
  // and tolerant of space↔underscore variants from the model.
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "_").trim();
  const wfName = decision.handler_name!;
  const target = norm(wfName);
  const { data: allWorkflows } = await ctx.admin
    .from("workflows")
    .select("id, name, trigger_tag, template")
    .eq("workspace_id", ctx.workspaceId)
    .eq("enabled", true);
  const workflow = (allWorkflows || []).find(w =>
    norm(w.name) === target ||
    (w.trigger_tag && norm(w.trigger_tag) === target) ||
    (w.template && norm(w.template as string) === target)
  ) || null;

  if (!workflow) {
    const reason = `Workflow not found: "${decision.handler_name}". Sonnet's intent was: ${decision.reasoning || "unknown"}`;
    await sysNote(reason);
    await escalateTicket(ctx, reason);
    await send(decision.response_message || "I need a little time to work on this and I'll get back to you.", ctx.sandbox);
    return false;
  }

  const { executeWorkflow } = await import("@/lib/workflow-executor");
  await executeWorkflow(ctx.workspaceId, ctx.ticketId, workflow.trigger_tag);
  return true;
}

// ── Handler: Macro ──

async function handleMacro(
  ctx: ActionContext,
  decision: SonnetDecision,
  send: SendFn,
): Promise<void> {
  // If Sonnet already generated a personalized response, use it directly
  if (decision.response_message) {
    await send(decision.response_message, ctx.sandbox);
    return;
  }

  if (!decision.handler_name) return;

  // Fall back to looking up macro body_html
  const { data: macro } = await ctx.admin
    .from("macros")
    .select("id, body_html")
    .eq("workspace_id", ctx.workspaceId)
    .eq("name", decision.handler_name)
    .single();

  if (macro?.body_html) {
    await send(macro.body_html, ctx.sandbox);
  }
}

// ── Handler: Escalate ──

async function handleEscalate(
  ctx: ActionContext,
  decision: SonnetDecision,
  send: SendFn,
  sysNote: SysNoteFn,
): Promise<void> {
  const reason = decision.reasoning || "Sonnet orchestrator escalated";
  await escalateTicket(ctx, reason);

  // Send holding message to customer. Sonnet's pre-authored
  // response_message is preferred for context-specific framing; fall
  // back to a generic team-handoff line that doesn't sound AI-y.
  const holdingMsg =
    decision.response_message ||
    "Someone on my team is working on this and we'll get back to you shortly!";
  await send(holdingMsg, ctx.sandbox);
  await sysNote(`Escalated: ${reason}`);
}

// ── Escalation Helper ──

async function escalateTicket(ctx: ActionContext, reason: string): Promise<void> {
  // Escalate to the AI Routine: escalated_at set + escalated_to = null (the
  // idle-triage cron's "routine-owned" signal). We don't round-robin to a
  // person or pre-assign assigned_to — the routine triages it next tick and its
  // no-quorum path is what escalates up to a real human.
  await ctx.admin
    .from("tickets")
    .update({
      status: "open",
      escalated_to: null,
      escalated_at: new Date().toISOString(),
      escalation_reason: reason,
    })
    .eq("id", ctx.ticketId);

  // Mark on the context so executeSonnetDecision returns escalated=true
  // and the post-execute auto-close in unified-ticket-handler skips.
  ctx._escalatedThisRun = true;
}
