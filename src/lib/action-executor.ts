/**
 * Action Executor — executes actions from the Sonnet orchestrator's decision.
 *
 * Takes a SonnetDecision (JSON action plan) and dispatches to the appropriate
 * handler: direct subscription actions, journeys, playbooks, workflows, macros,
 * KB/AI responses, or escalation.
 */

import { createAdminClient } from "@/lib/supabase/admin";

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

interface ActionParams {
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
  reason?: string;
  tier_index?: number;
  shopify_order_id?: string;
  amount_cents?: number;
  base_price_cents?: number;
  crisis_action_id?: string;
}

export interface ActionContext {
  admin: Admin;
  workspaceId: string;
  ticketId: string;
  customerId: string;
  channel: string;
  sandbox: boolean;
}

type SendFn = (msg: string, sandbox: boolean) => Promise<void>;
type SysNoteFn = (msg: string) => Promise<void>;

interface ActionResult {
  success: boolean;
  error?: string;
  summary?: string;
}

// ── Direct Action Handler Registry ──

const directActionHandlers: Record<
  string,
  (ctx: ActionContext, p: ActionParams) => Promise<ActionResult>
> = {
  resume: async (ctx, p) => {
    const { appstleSubscriptionAction } = await import("@/lib/appstle");
    const r = await appstleSubscriptionAction(ctx.workspaceId, p.contract_id!, "resume");
    return { ...r, summary: "Resumed subscription" };
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
    const { appstleUpdateNextBillingDate } = await import("@/lib/appstle");
    const r = await appstleUpdateNextBillingDate(ctx.workspaceId, p.contract_id!, p.date!);
    return { ...r, summary: `Changed next billing date to ${p.date}` };
  },

  add_item: async (ctx, p) => {
    const { subAddItem } = await import("@/lib/subscription-items");
    const r = await subAddItem(ctx.workspaceId, p.contract_id!, p.variant_id!, p.quantity || 1);
    return { ...r, summary: `Added item (qty: ${p.quantity || 1})` };
  },

  remove_item: async (ctx, p) => {
    const { subRemoveItem } = await import("@/lib/subscription-items");
    const r = await subRemoveItem(ctx.workspaceId, p.contract_id!, p.variant_id!);
    return { ...r, summary: "Removed item" };
  },

  swap_variant: async (ctx, p) => {
    const { subSwapVariant } = await import("@/lib/subscription-items");
    const r = await subSwapVariant(
      ctx.workspaceId, p.contract_id!, p.old_variant_id!, p.new_variant_id!, p.quantity || 1,
    );
    return { ...r, summary: "Swapped item" };
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
    const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
    const { getAppstleConfig } = await import("@/lib/subscription-items");
    const config = await getAppstleConfig(ctx.workspaceId);
    if (!config) return { success: false, error: "Appstle not configured" };
    const r = await applyDiscountWithReplace(config.apiKey, p.contract_id!, p.code!);
    return { ...r, summary: `Applied coupon ${p.code}` };
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
              appliesOnOneTimePurchase: false,
              appliesOnSubscription: true,
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
    };
  },

  apply_loyalty_coupon: async (ctx, p) => {
    const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
    const { getAppstleConfig } = await import("@/lib/subscription-items");
    const config = await getAppstleConfig(ctx.workspaceId);
    if (!config) return { success: false, error: "Appstle not configured" };

    // Try applying the existing coupon first
    const r = await applyDiscountWithReplace(config.apiKey, p.contract_id!, p.code!);
    if (r.success) return { ...r, summary: `Applied loyalty coupon ${p.code}` };

    // Coupon failed — may be stale/deleted in Shopify. Generate a fresh one.
    try {
      const { getLoyaltySettings, getRedemptionTiers, spendPoints } = await import("@/lib/loyalty");
      const { getShopifyCredentials } = await import("@/lib/shopify-sync");
      const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");

      // Find the original redemption to get tier info
      const { data: orig } = await ctx.admin.from("loyalty_redemptions")
        .select("id, member_id, discount_value, points_spent")
        .eq("discount_code", p.code!).eq("workspace_id", ctx.workspaceId).single();
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
            customerGets: { appliesOnOneTimePurchase: false, appliesOnSubscription: true, items: { all: true }, value: { discountAmount: { amount: orig.discount_value, appliesOnEachItem: false } } },
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
        return { success: true, summary: `Applied loyalty coupon $${orig.discount_value} off (regenerated: ${newCode})` };
      }
      return { success: false, error: `Regenerated coupon also failed: ${r2.error}` };
    } catch (e) {
      return { success: false, error: `Coupon regeneration failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },

  update_line_item_price: async (ctx, p) => {
    const { subUpdateLineItemPrice } = await import("@/lib/subscription-items");
    // Resolve variant — if Sonnet passed a bad variant or none, use the first item on the subscription
    let variantId = p.variant_id;
    if (!variantId || !(await ctx.admin.from("subscriptions").select("items").eq("shopify_contract_id", p.contract_id!).single()).data?.items?.some((i: { variant_id?: string }) => String(i.variant_id) === String(variantId))) {
      const { data: sub } = await ctx.admin.from("subscriptions").select("items").eq("shopify_contract_id", p.contract_id!).single();
      const items = (sub?.items as { variant_id?: string; title?: string }[]) || [];
      const realItems = items.filter(i => !(i.title || "").toLowerCase().includes("shipping protection"));
      variantId = realItems[0]?.variant_id || variantId;
    }
    const r = await subUpdateLineItemPrice(ctx.workspaceId, p.contract_id!, variantId!, p.base_price_cents!);
    return { ...r, summary: `Updated base price to $${((p.base_price_cents || 0) / 100).toFixed(2)}` };
  },

  partial_refund: async (ctx, p) => {
    const { partialRefundByAmount } = await import("@/lib/shopify-order-actions");
    const amountDecimal = ((p.amount_cents || 0) / 100).toFixed(2);
    const reason = p.reason || "Price adjustment — customer was overcharged";

    const r = await partialRefundByAmount(ctx.workspaceId, p.shopify_order_id!, p.amount_cents!, reason);
    if (r.success) {
      await notifySlack(ctx, p, amountDecimal);
    }
    return { ...r, summary: r.success ? `Partial refund of $${amountDecimal} issued (${reason})` : undefined };
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
    const r = await appstleSubscriptionAction(ctx.workspaceId, p.contract_id!, "pause", "Crisis — customer requested pause until restock");
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
): Promise<void> {
  // Handle clarification first — applies regardless of action_type
  if (decision.needs_clarification && decision.clarification_question) {
    await send(decision.clarification_question, ctx.sandbox);
    return;
  }

  switch (decision.action_type) {
    case "direct_action":
      await handleDirectAction(ctx, decision, send, sysNote);
      break;

    case "journey":
      await handleJourney(ctx, decision, send, sysNote);
      break;

    case "playbook":
      await handlePlaybook(ctx, decision, personality, send, sysNote);
      break;

    case "workflow":
      await handleWorkflow(ctx, decision, sysNote);
      break;

    case "macro":
      await handleMacro(ctx, decision, send);
      break;

    case "kb_response":
    case "ai_response":
      if (decision.response_message) {
        await send(decision.response_message, ctx.sandbox);
      }
      break;

    case "escalate":
      await handleEscalate(ctx, decision, send, sysNote);
      break;

    default:
      await sysNote(`Unknown action_type: ${decision.action_type}`);
  }
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

  for (const action of actions) {
    const handler = directActionHandlers[action.type];
    if (!handler) {
      results.push({
        action,
        result: { success: false, error: `Unknown action type: ${action.type}` },
      });
      continue;
    }

    try {
      const result = await handler(ctx, action);
      results.push({ action, result });
    } catch (err) {
      results.push({
        action,
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
    // All succeeded — send confirmation
    if (decision.response_message) {
      await send(decision.response_message, ctx.sandbox);
    }
  } else {
    // Some failed — send error + escalate
    const errorMsg =
      "I ran into an issue processing your request. Let me connect you with a team member who can help.";
    await send(errorMsg, ctx.sandbox);
    await escalateTicket(ctx, `Direct action failures: ${failures.map((f) => `${f.action.type}: ${f.result.error}`).join("; ")}`);
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

  // Look up journey by name
  const { data: journey } = await ctx.admin
    .from("journey_definitions")
    .select("id, name, trigger_intent")
    .eq("workspace_id", ctx.workspaceId)
    .eq("name", decision.handler_name)
    .eq("is_active", true)
    .single();

  if (!journey) {
    await sysNote(`Journey not found: ${decision.handler_name}`);
    return;
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
    leadIn: decision.response_message || "",
    ctaText: "Get Started",
  });

  if (launched) {
    await ctx.admin
      .from("tickets")
      .update({ handled_by: `Journey: ${journey.name}` })
      .eq("id", ctx.ticketId);
  } else {
    await sysNote(`Journey could not be launched on channel: ${ctx.channel}`);
    // Fall back to sending the response message directly
    if (decision.response_message) {
      await send(decision.response_message, ctx.sandbox);
    }
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

  // Look up playbook by name
  const { data: playbook } = await ctx.admin
    .from("playbooks")
    .select("id, name")
    .eq("workspace_id", ctx.workspaceId)
    .eq("name", decision.handler_name)
    .eq("is_active", true)
    .single();

  if (!playbook) {
    await sysNote(`Playbook not found: ${decision.handler_name}`);
    return;
  }

  const { startPlaybook, executePlaybookStep } = await import("@/lib/playbook-executor");

  // Start the playbook on this ticket
  await startPlaybook(ctx.admin, ctx.ticketId, playbook.id);

  // Execute the first step
  const result = await executePlaybookStep(
    ctx.workspaceId,
    ctx.ticketId,
    "", // no customer message for first step
    personality,
  );

  // Set handled_by
  await ctx.admin
    .from("tickets")
    .update({ handled_by: `Playbook: ${playbook.name}` })
    .eq("id", ctx.ticketId);

  if (result.response) {
    await send(result.response, ctx.sandbox);
  }
  if (result.systemNote) {
    await sysNote(result.systemNote);
  }
}

// ── Handler: Workflow ──

async function handleWorkflow(
  ctx: ActionContext,
  decision: SonnetDecision,
  sysNote: SysNoteFn,
): Promise<void> {
  if (!decision.handler_name) {
    await sysNote("Workflow action missing handler_name.");
    return;
  }

  // Look up workflow by name to get its trigger_tag
  const { data: workflow } = await ctx.admin
    .from("workflows")
    .select("id, name, trigger_tag")
    .eq("workspace_id", ctx.workspaceId)
    .eq("name", decision.handler_name)
    .eq("enabled", true)
    .single();

  if (!workflow) {
    await sysNote(`Workflow not found: ${decision.handler_name}`);
    return;
  }

  const { executeWorkflow } = await import("@/lib/workflow-executor");
  await executeWorkflow(ctx.workspaceId, ctx.ticketId, workflow.trigger_tag);

  // Set handled_by
  await ctx.admin
    .from("tickets")
    .update({ handled_by: `Workflow: ${workflow.name}` })
    .eq("id", ctx.ticketId);
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

  // Send holding message to customer
  const holdingMsg =
    decision.response_message ||
    "Let me connect you with a team member who can help with this right away.";
  await send(holdingMsg, ctx.sandbox);
  await sysNote(`Escalated: ${reason}`);
}

// ── Escalation Helper ──

async function escalateTicket(ctx: ActionContext, reason: string): Promise<void> {
  // Find next available agent via round-robin
  const { data: agents } = await ctx.admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", ctx.workspaceId)
    .in("role", ["admin", "agent", "owner"])
    .order("user_id");

  const assignee = agents?.[0]?.user_id || null;

  await ctx.admin
    .from("tickets")
    .update({
      status: "open",
      assigned_to: assignee,
      escalation_reason: reason,
    })
    .eq("id", ctx.ticketId);
}
