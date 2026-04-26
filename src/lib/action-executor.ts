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
  order_number?: string;
  free_label?: boolean;
  pause_days?: number;
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

    // Brief delay — coupon may have just been created in Shopify and needs a moment to propagate
    await new Promise(resolve => setTimeout(resolve, 2000));

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
    const { getAppstleConfig } = await import("@/lib/subscription-items");

    if (!p.contract_id) return { success: false, error: "Missing contract_id" };
    if (p.base_price_cents == null) return { success: false, error: "Missing base_price_cents" };

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
      shopifyOrderGid: `gid://shopify/Order/${order.shopify_order_id}`,
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
      return { ...r, summary: `Return created for ${order.order_number}. Label: ${r.labelUrl} | Tracking: ${r.trackingNumber}` };
    }
    return { ...r, summary: r.success ? `Return created for ${order.order_number}` : undefined };
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

  redeem_points_as_refund: async (ctx, p) => {
    const { getLoyaltySettings, getRedemptionTiers, validateRedemption, spendPoints } = await import("@/lib/loyalty");
    const { partialRefundByAmount } = await import("@/lib/shopify-order-actions");

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
      .select("order_number, total_cents, financial_status")
      .eq("workspace_id", ctx.workspaceId).eq("shopify_order_id", p.shopify_order_id).single();
    if (!order) return { success: false, error: "Order not found" };
    if (order.financial_status === "refunded") return { success: false, error: "Order already fully refunded" };

    const amountCents = tier.discount_value * 100;
    const reason = `Loyalty redemption — ${tier.points_cost} points for $${tier.discount_value} partial refund on renewal order #${order.order_number}`;

    const refund = await partialRefundByAmount(ctx.workspaceId, p.shopify_order_id, amountCents, reason);
    if (!refund.success) return { ...refund, summary: undefined };

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
    };
  },

  pause_timed: async (ctx, p) => {
    const { appstleSubscriptionAction } = await import("@/lib/appstle");
    if (!p.contract_id) return { success: false, error: "Missing contract_id" };
    if (p.pause_days !== 30 && p.pause_days !== 60) return { success: false, error: "pause_days must be 30 or 60" };

    const r = await appstleSubscriptionAction(
      ctx.workspaceId, p.contract_id, "pause",
      `Customer requested ${p.pause_days}-day pause after renewal charge`,
    );
    if (!r.success) return { ...r, summary: undefined };

    const resumeAt = new Date(Date.now() + p.pause_days * 86400000);
    await ctx.admin.from("subscriptions")
      .update({
        status: "paused",
        pause_resume_at: resumeAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", ctx.workspaceId)
      .eq("shopify_contract_id", p.contract_id);

    const resumeLabel = resumeAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    return { success: true, summary: `Paused for ${p.pause_days} days (auto-resumes ${resumeLabel})` };
  },

  // Alias: Sonnet sometimes emits { type: "pause" } expecting the same behavior
  // as pause_timed. Default to 30 days if no duration specified.
  pause: async (ctx, p) => {
    const days = p.pause_days || 30;
    if (days !== 30 && days !== 60) {
      return {
        success: false,
        error: `pause action only supports 30 or 60 day durations (got ${days}). For longer pauses, an agent must apply manually.`,
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

  create_replacement_order: async (ctx, p) => {
    const { getShopifyCredentials } = await import("@/lib/shopify-sync");
    const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
    const { shop, accessToken } = await getShopifyCredentials(ctx.workspaceId);

    // Get customer's Shopify ID and shipping address from their subscription
    const { data: cust } = await ctx.admin.from("customers")
      .select("shopify_customer_id").eq("id", ctx.customerId).single();
    if (!cust?.shopify_customer_id) return { success: false, error: "No Shopify customer ID" };

    // Get shipping address from any active sub
    const { data: subs } = await ctx.admin.from("subscriptions")
      .select("shipping_address").eq("customer_id", ctx.customerId).eq("status", "active").limit(1);
    const addr = (subs?.[0]?.shipping_address || {}) as Record<string, string>;
    if (!addr.address1) return { success: false, error: "No shipping address found" };

    const variantId = p.variant_id || "42614433513645"; // default Peach Mango
    const quantity = p.quantity || 1;

    const draftRes = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } } }`,
        variables: {
          input: {
            customerId: `gid://shopify/Customer/${cust.shopify_customer_id}`,
            lineItems: [{ variantId: `gid://shopify/ProductVariant/${variantId}`, quantity }],
            shippingAddress: {
              firstName: addr.firstName || addr.first_name || "",
              lastName: addr.lastName || addr.last_name || "",
              address1: addr.address1 || "", address2: addr.address2 || "",
              city: addr.city || "",
              provinceCode: addr.provinceCode || addr.province_code || addr.province || "",
              zip: addr.zip || "", countryCode: "US",
            },
            note: "Replacement order — crisis swap compensation",
            tags: ["replacement", "crisis"],
            appliedDiscount: { value: 100.0, valueType: "PERCENTAGE", title: "Replacement" },
          },
        },
      }),
    });
    const draftData = await draftRes.json();
    if (draftData.data?.draftOrderCreate?.userErrors?.length) {
      return { success: false, error: draftData.data.draftOrderCreate.userErrors.map((e: { message: string }) => e.message).join(", ") };
    }
    const draftId = draftData.data?.draftOrderCreate?.draftOrder?.id;
    if (!draftId) return { success: false, error: "Draft order creation failed" };

    // Complete the draft
    const completeRes = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query: `mutation { draftOrderComplete(id: "${draftId}") { draftOrder { order { name } } userErrors { message } } }` }),
    });
    const completeData = await completeRes.json();
    const orderName = completeData.data?.draftOrderComplete?.draftOrder?.order?.name;

    return { success: true, summary: `Replacement order ${orderName || "created"} — ${quantity}x Peach Mango shipped free` };
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
): Promise<{ messageSent: boolean }> {
  // Handle clarification first — applies regardless of action_type
  if (decision.needs_clarification && decision.clarification_question) {
    await send(decision.clarification_question, ctx.sandbox);
    return { messageSent: true };
  }

  // Track whether a customer-facing message was sent
  let messageSent = false;
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
      await handleWorkflow(ctx, decision, sysNote);
      break;

    case "macro":
      await handleMacro(ctx, decision, trackedSend);
      break;

    case "kb_response":
    case "ai_response":
      if (decision.response_message) {
        await trackedSend(decision.response_message, ctx.sandbox);
      }
      break;

    case "escalate":
      await handleEscalate(ctx, decision, trackedSend, sysNote);
      break;

    default:
      await sysNote(`Unknown action_type: ${decision.action_type}`);
  }

  return { messageSent };
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

    // Self-healing: verify actions actually took effect in the DB
    await new Promise(resolve => setTimeout(resolve, 3000));
    const verifyFailures: string[] = [];

    for (const s of successes) {
      const verified = await verifyActionInDB(ctx, s.action);
      if (!verified) {
        const { addTicketTag } = await import("@/lib/ticket-tags");
        await addTicketTag(ctx.ticketId, "ai:fix");
        await sysNote(`[Self-heal] Verification failed for ${s.action.type} — retrying...`);

        // Retry the action once
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
    // Some failed — send error + escalate
    const errorMsg =
      "I ran into an issue processing your request. I'm going to look into this and send you an email shortly.";
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

  // Fallback: case-insensitive name match
  if (!journey) {
    const { data: all } = await ctx.admin
      .from("journey_definitions")
      .select("id, name, trigger_intent")
      .eq("workspace_id", ctx.workspaceId)
      .eq("is_active", true);
    journey = (all || []).find(j =>
      j.name.toLowerCase() === handlerName.toLowerCase() ||
      j.trigger_intent?.toLowerCase() === handlerName.toLowerCase()
    ) || null;
  }

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
    ctaText: `${journey.name} →`,
  });

  if (!launched) {
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

  // Look up playbook by name or trigger_intents (case-insensitive)
  const pbName = decision.handler_name!;
  const { data: allPlaybooks } = await ctx.admin
    .from("playbooks")
    .select("id, name, trigger_intents")
    .eq("workspace_id", ctx.workspaceId)
    .eq("is_active", true);
  const playbook = (allPlaybooks || []).find(p =>
    p.name.toLowerCase() === pbName.toLowerCase() ||
    ((p.trigger_intents as string[]) || []).some(i => i.toLowerCase() === pbName.toLowerCase())
  ) || null;

  if (!playbook) {
    await sysNote(`Playbook not found: ${decision.handler_name}`);
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
    // Starting new playbook
    await startPlaybook(ctx.admin, ctx.ticketId, playbook.id);

    let result = await executePlaybookStep(
      ctx.workspaceId, ctx.ticketId,
      "", // no customer message for first step
      personality,
    );

    if (result.systemNote) await sysNote(result.systemNote);
    if (result.response) { await send(result.response, ctx.sandbox); return; }

    // Auto-advance for initial step too
    let advances = 0;
    while (result.action === "advance" && advances < 10) {
      advances++;
      result = await executePlaybookStep(ctx.workspaceId, ctx.ticketId, "", personality);
      if (result.systemNote) await sysNote(result.systemNote);
      if (result.response) { await send(result.response, ctx.sandbox); return; }
      if (result.action === "complete") break;
    }
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

  // Look up workflow by name or trigger_tag (case-insensitive)
  const wfName = decision.handler_name!;
  const { data: allWorkflows } = await ctx.admin
    .from("workflows")
    .select("id, name, trigger_tag, template")
    .eq("workspace_id", ctx.workspaceId)
    .eq("enabled", true);
  const workflow = (allWorkflows || []).find(w =>
    w.name.toLowerCase() === wfName.toLowerCase() ||
    w.trigger_tag?.toLowerCase() === wfName.toLowerCase() ||
    (w.template as string)?.toLowerCase() === wfName.toLowerCase()
  ) || null;

  if (!workflow) {
    await sysNote(`Workflow not found: ${decision.handler_name}`);
    return;
  }

  const { executeWorkflow } = await import("@/lib/workflow-executor");
  await executeWorkflow(ctx.workspaceId, ctx.ticketId, workflow.trigger_tag);

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
    "I'm going to look into this and send you an email shortly.";
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
      escalated_to: assignee,
      escalated_at: new Date().toISOString(),
      escalation_reason: reason,
    })
    .eq("id", ctx.ticketId);
}
