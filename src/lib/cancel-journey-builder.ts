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

// Cancel reasons come from Settings → Cancel Flow (database only, no hardcoded defaults)
async function loadCancelReasons(workspaceId: string): Promise<{ value: string; label: string }[]> {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("portal_config")
    .eq("id", workspaceId)
    .single();

  const portalConfig = (ws?.portal_config || {}) as Record<string, unknown>;
  const cancelConfig = (portalConfig.cancel_flow || {}) as Record<string, unknown>;
  const configuredReasons = Array.isArray(cancelConfig.reasons) ? cancelConfig.reasons : [];

  return configuredReasons
    .filter((r: { enabled?: boolean }) => r.enabled !== false)
    .sort((a: { sort_order?: number }, b: { sort_order?: number }) => (a.sort_order ?? 99) - (b.sort_order ?? 99))
    .map((r: { slug?: string; label?: string }) => ({ value: r.slug || "", label: r.label || "" }));
}

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

  // Fetch active + paused subscriptions across main + linked accounts.
  // Paused subs are still on the hook for a future renewal — a customer
  // who decides to cancel a paused sub should be able to do so through
  // the journey without unpause-then-cancel friction.
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, items, next_billing_date, status, billing_interval, billing_interval_count, created_at")
    .in("customer_id", allCustomerIds)
    .eq("workspace_id", workspaceId)
    .in("status", ["active", "paused"])
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
  const cancelReasons = await loadCancelReasons(workspaceId);
  steps.push({
    key: "cancel_reason",
    type: "single_choice",
    question: "Why are you cancelling?",
    options: cancelReasons,
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
