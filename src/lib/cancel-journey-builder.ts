/**
 * Build cancel journey steps from customer subscriptions + remedies.
 * Code-driven journey: subscription select → reason → AI remedies → resolution.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface CancelJourneyStep {
  key: string;
  type: "radio" | "single_choice" | "subscription_select" | "remedy_select" | "ai_chat" | "confirm" | "info";
  question: string;
  subtitle?: string;
  options?: { value: string; label: string; emoji?: string }[];
}

export interface CancelJourneyMetadata {
  customerId: string;
  workspaceId: string;
  ticketId: string;
  subscriptions: {
    id: string;
    contractId: string;
    items: { title: string; variant_title?: string; quantity: number }[];
    nextBillingDate: string | null;
    totalPrice: string | null;
    frequency: string | null;
    paymentLast4: string | null;
    hasShippingProtection: boolean;
    isFirstRenewal: boolean;
    subscriptionAgeDays: number;
  }[];
  selectedSubscriptionId?: string;
}

const CANCEL_REASONS = [
  { value: "too_expensive", label: "Too expensive", emoji: "💸" },
  { value: "too_much_product", label: "I have too much product", emoji: "📦" },
  { value: "not_seeing_results", label: "I'm not seeing results", emoji: "😕" },
  { value: "reached_goals", label: "I've already reached my goals", emoji: "🎯" },
  { value: "taste_texture", label: "I don't like the taste or texture", emoji: "😬" },
  { value: "health_change", label: "My health needs have changed", emoji: "🏥" },
  { value: "just_pausing", label: "I just need a break", emoji: "⏸️" },
  { value: "something_else", label: "Something else", emoji: "💬" },
];

export async function buildCancelJourneySteps(
  workspaceId: string,
  customerId: string,
  ticketId: string,
): Promise<{ steps: CancelJourneyStep[]; metadata: CancelJourneyMetadata }> {
  const admin = createAdminClient();

  // Get all linked customer IDs for subscription lookup
  let allCustomerIds = [customerId];
  const { data: links } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId);
  if (links?.[0]?.group_id) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", links[0].group_id);
    allCustomerIds = (grp || []).map(m => m.customer_id);
  }

  // Fetch active subscriptions across main + linked accounts
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, items, next_billing_date, status, billing_interval, billing_interval_count, created_at")
    .in("customer_id", allCustomerIds)
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("next_billing_date", { ascending: true });

  if (!subs?.length) {
    return {
      steps: [],
      metadata: {
        customerId,
        workspaceId,
        ticketId,
        subscriptions: [],
      },
    };
  }

  // Build subscription metadata
  const subscriptions = subs.map(sub => {
    const items = (sub.items as { title: string; variant_title?: string; quantity: number; price?: string }[] || []);
    const shippingProtectionKeywords = ["shipping protection", "route", "shipping insurance"];
    const hasShippingProtection = items.some(i =>
      shippingProtectionKeywords.some(kw => i.title.toLowerCase().includes(kw))
    );

    const totalPrice = items
      .filter(i => !shippingProtectionKeywords.some(kw => i.title.toLowerCase().includes(kw)))
      .reduce((sum, i) => sum + (parseFloat(i.price || "0") * (i.quantity || 1)), 0);

    const freq = sub.billing_interval && sub.billing_interval_count
      ? `Every ${sub.billing_interval_count} ${sub.billing_interval}${sub.billing_interval_count > 1 ? "s" : ""}`
      : null;

    // Detect first-renewal customers (never renewed yet)
    const subAgeDays = sub.created_at
      ? Math.floor((Date.now() - new Date(sub.created_at).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    const billingIntervalDays = sub.billing_interval === "month"
      ? (sub.billing_interval_count || 1) * 30
      : sub.billing_interval === "week"
      ? (sub.billing_interval_count || 1) * 7
      : 30;
    const isFirstRenewal = subAgeDays < billingIntervalDays;

    return {
      id: sub.id,
      contractId: sub.shopify_contract_id,
      items: items.filter(i => !shippingProtectionKeywords.some(kw => i.title.toLowerCase().includes(kw))),
      nextBillingDate: sub.next_billing_date,
      totalPrice: totalPrice > 0 ? `$${totalPrice.toFixed(2)}` : null,
      frequency: freq,
      paymentLast4: null as string | null,
      hasShippingProtection,
      isFirstRenewal,
      subscriptionAgeDays: subAgeDays,
    };
  });

  const steps: CancelJourneyStep[] = [];

  // Step 1: Select subscription (skip if only one)
  if (subscriptions.length > 1) {
    steps.push({
      key: "select_subscription",
      type: "subscription_select",
      question: "Which subscription would you like to cancel?",
      options: subscriptions.map((sub, idx) => {
        const names = sub.items.map(i => i.title).join(", ");
        const nextDate = sub.nextBillingDate
          ? new Date(sub.nextBillingDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "";
        return {
          value: sub.id,
          label: `${names}${nextDate ? ` — renews ${nextDate}` : ""}${sub.totalPrice ? ` — ${sub.totalPrice}` : ""}`,
        };
      }),
    });
  }

  // Step 2: Why are you cancelling?
  steps.push({
    key: "cancel_reason",
    type: "single_choice",
    question: "Why are you cancelling?",
    options: CANCEL_REASONS,
  });

  // Step 3 is dynamic — AI remedy selection or AI chat (built at runtime on server)
  // The mini-site will POST the reason, server returns remedies or initiates chat

  return {
    steps,
    metadata: {
      customerId,
      workspaceId,
      ticketId,
      subscriptions,
      selectedSubscriptionId: subscriptions.length === 1 ? subscriptions[0].id : undefined,
    },
  };
}
