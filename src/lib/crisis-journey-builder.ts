/**
 * Crisis Journey Builder — builds steps for crisis tier journeys.
 *
 * Tier 1: Flavor swap (single choice from available_flavor_swaps)
 * Tier 2: Product swap + coupon (single choice from available_product_swaps, then quantity)
 * Tier 3: Pause/remove (berry_only → pause vs cancel, berry_plus → remove vs cancel)
 */

import type { BuiltJourneyConfig } from "@/lib/journey-step-builder";
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export async function buildCrisisTier1Steps(
  admin: Admin, workspaceId: string, customerId: string, ticketId: string,
): Promise<BuiltJourneyConfig> {
  // Find the crisis action for this customer + ticket
  const action = await getCrisisAction(admin, workspaceId, customerId, ticketId);
  if (!action) return emptyConfig();

  const { data: crisis } = await admin.from("crisis_events")
    .select("*").eq("id", action.crisis_id).single();
  if (!crisis) return emptyConfig();

  const flavorSwaps = (crisis.available_flavor_swaps as { variantId: string; title: string }[]) || [];
  if (flavorSwaps.length === 0) return emptyConfig();

  const defaultSwap = crisis.default_swap_title || "current swap";

  return {
    codeDriven: true,
    multiStep: false,
    steps: [{
      key: "flavor_choice",
      type: "single_choice",
      question: `We've temporarily switched your ${crisis.affected_product_title || "item"} to ${defaultSwap}. Want a different flavor instead?`,
      subtitle: "Pick the flavor you'd like, or keep the current swap.",
      options: [
        ...flavorSwaps.map(f => ({ value: f.variantId, label: f.title })),
        { value: "keep_current", label: `Keep ${defaultSwap}` },
        { value: "reject", label: "I don't want to change flavors" },
      ],
    }],
    metadata: {
      journeyType: "crisis_tier1",
      crisisId: action.crisis_id,
      actionId: action.id,
      subscriptionId: action.subscription_id,
      customerId,
      workspaceId,
      ticketId,
      affectedVariantId: crisis.affected_variant_id,
      defaultSwapVariantId: crisis.default_swap_variant_id,
    },
  };
}

export async function buildCrisisTier2Steps(
  admin: Admin, workspaceId: string, customerId: string, ticketId: string,
): Promise<BuiltJourneyConfig> {
  const action = await getCrisisAction(admin, workspaceId, customerId, ticketId);
  if (!action) return emptyConfig();

  const { data: crisis } = await admin.from("crisis_events")
    .select("*").eq("id", action.crisis_id).single();
  if (!crisis) return emptyConfig();

  const productSwaps = (crisis.available_product_swaps as { variantId: string; title: string; productTitle: string }[]) || [];
  if (productSwaps.length === 0) return emptyConfig();

  const couponPct = crisis.tier2_coupon_percent || 20;

  return {
    codeDriven: true,
    multiStep: true,
    steps: [
      {
        key: "product_choice",
        type: "single_choice",
        question: `We'd love to help you try something new — and we'll give you ${couponPct}% off your next order!`,
        subtitle: "Pick a product you'd like to try instead.",
        options: [
          ...productSwaps.map(p => ({ value: p.variantId, label: `${p.productTitle} — ${p.title}` })),
          { value: "reject", label: "I don't want to change products" },
        ],
      },
      {
        key: "product_quantity",
        type: "single_choice",
        question: "How many would you like?",
        options: [
          { value: "1", label: "1" },
          { value: "2", label: "2" },
          { value: "3", label: "3" },
          { value: "4", label: "4" },
        ],
      },
    ],
    metadata: {
      journeyType: "crisis_tier2",
      crisisId: action.crisis_id,
      actionId: action.id,
      subscriptionId: action.subscription_id,
      customerId,
      workspaceId,
      ticketId,
      affectedVariantId: crisis.affected_variant_id,
      tier2CouponCode: crisis.tier2_coupon_code,
      tier2CouponPercent: couponPct,
    },
  };
}

export async function buildCrisisTier3Steps(
  admin: Admin, workspaceId: string, customerId: string, ticketId: string,
): Promise<BuiltJourneyConfig> {
  const action = await getCrisisAction(admin, workspaceId, customerId, ticketId);
  if (!action) return emptyConfig();

  const { data: crisis } = await admin.from("crisis_events")
    .select("*").eq("id", action.crisis_id).single();
  if (!crisis) return emptyConfig();

  const restockDate = crisis.expected_restock_date
    ? new Date(crisis.expected_restock_date).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : "a few months";

  const isBerryOnly = action.segment === "berry_only";

  return {
    codeDriven: true,
    multiStep: false,
    steps: [{
      key: "tier3_choice",
      type: "single_choice",
      question: isBerryOnly
        ? `We'll pause your subscription and automatically restart it when ${crisis.affected_product_title || "your item"} is back in stock (expected ${restockDate}).`
        : `We'll remove ${crisis.affected_product_title || "the out-of-stock item"} from your subscription and keep shipping your other items. We'll add it back when it's in stock (expected ${restockDate}).`,
      subtitle: isBerryOnly
        ? "You won't be charged while paused."
        : "Your other items will ship as usual.",
      options: isBerryOnly
        ? [
            { value: "pause", label: "Pause until it's back" },
            { value: "cancel", label: "I'd rather cancel" },
          ]
        : [
            { value: "remove", label: "Remove it for now" },
            { value: "cancel", label: "I'd rather cancel the whole subscription" },
          ],
    }],
    metadata: {
      journeyType: "crisis_tier3",
      crisisId: action.crisis_id,
      actionId: action.id,
      subscriptionId: action.subscription_id,
      customerId,
      workspaceId,
      ticketId,
      segment: action.segment,
      affectedVariantId: crisis.affected_variant_id,
    },
  };
}

// ── Helpers ──

async function getCrisisAction(admin: Admin, workspaceId: string, customerId: string, ticketId: string) {
  // Find the most recent active crisis action for this customer
  const { data } = await admin.from("crisis_customer_actions")
    .select("id, crisis_id, subscription_id, segment, current_tier")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

function emptyConfig(): BuiltJourneyConfig {
  return {
    codeDriven: true,
    multiStep: false,
    steps: [{
      key: "no_crisis",
      type: "info",
      question: "No active crisis found for your account.",
      isTerminal: true,
    }],
  };
}
