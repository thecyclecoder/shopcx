/**
 * Build a multi-step mini-site config for the discount journey.
 * Inspects customer profiles to determine which steps are needed.
 */

import { createAdminClient } from "@/lib/supabase/admin";

interface DiscountStep {
  key: string;
  type: "confirm" | "radio" | "info";
  question: string;
  subtitle?: string;
  options?: { value: string; label: string }[];
  // For info steps (coupon display, completion)
  html?: string;
}

export async function buildDiscountJourneySteps(
  workspaceId: string,
  customerId: string,
): Promise<{ steps: DiscountStep[]; metadata: Record<string, unknown> }> {
  const admin = createAdminClient();

  // Get all linked customer IDs
  const { data: links } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId);
  let allCustomerIds = [customerId];
  if (links?.[0]?.group_id) {
    const { data: groupMembers } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", links[0].group_id);
    allCustomerIds = (groupMembers || []).map(m => m.customer_id);
  }

  // Get all profiles
  const { data: allProfiles } = await admin
    .from("customers")
    .select("id, email, phone, email_marketing_status, sms_marketing_status, shopify_customer_id, retention_score")
    .in("id", allCustomerIds);

  const profiles = allProfiles || [];

  const anyEmailSubscribed = profiles.some(p => p.email_marketing_status === "subscribed");
  const anySmsSubscribed = profiles.some(p => p.sms_marketing_status === "subscribed");
  const emails = [...new Set(profiles.map(p => p.email).filter(Boolean))];
  const phones = [...new Set(profiles.map(p => p.phone).filter(Boolean))];

  // Get coupon info
  const { data: ws } = await admin.from("workspaces").select("vip_retention_threshold").eq("id", workspaceId).single();
  const vipThreshold = ws?.vip_retention_threshold || 85;
  const maxRetention = Math.max(...profiles.map(p => p.retention_score || 0));
  const isVip = maxRetention >= vipThreshold;

  const { data: coupons } = await admin
    .from("coupon_mappings")
    .select("code, summary, customer_tier")
    .eq("workspace_id", workspaceId)
    .eq("ai_enabled", true);

  const eligible = (coupons || []).filter(c =>
    c.customer_tier === "all" ||
    (c.customer_tier === "vip" && isVip) ||
    (c.customer_tier === "non_vip" && !isVip)
  );
  const coupon = eligible[0];

  // Get active subscription with nearest renewal
  const { data: activeSubs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, next_billing_date, items")
    .in("customer_id", allCustomerIds)
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("next_billing_date", { ascending: true })
    .limit(1);

  const sub = activeSubs?.[0];

  // Build steps
  const steps: DiscountStep[] = [];
  const metadata: Record<string, unknown> = {
    allCustomerIds,
    couponCode: coupon?.code || null,
    couponSummary: coupon?.summary || null,
    isVip,
  };

  // Step 1: Consent (skip if already subscribed to both)
  if (!anyEmailSubscribed || !anySmsSubscribed) {
    steps.push({
      key: "consent",
      type: "confirm",
      question: "We have exclusive coupons for our email and SMS subscribers!",
      subtitle: "Would you like to sign up to get the latest deals delivered to you?",
    });
  }

  // Step 2: Which email? (only if not subscribed + multiple emails)
  if (!anyEmailSubscribed && emails.length > 1) {
    steps.push({
      key: "email_choice",
      type: "radio",
      question: "Which email would you like to receive coupons at?",
      options: emails.map(e => ({ value: e, label: e })),
    });
    metadata.emails = emails;
  } else if (!anyEmailSubscribed && emails.length === 1) {
    metadata.autoEmail = emails[0];
  }

  // Step 3: Which phone? (only if not subscribed + multiple phones)
  if (!anySmsSubscribed && phones.length > 1) {
    steps.push({
      key: "phone_choice",
      type: "radio",
      question: "Which phone number would you like coupon notifications sent to?",
      options: phones.map(p => ({ value: p as string, label: p as string })),
    });
    metadata.phones = phones;
  } else if (!anySmsSubscribed && phones.length === 1) {
    metadata.autoPhone = phones[0];
  }

  // Step 4: Apply to subscription? (only if active sub exists)
  if (sub?.shopify_contract_id && coupon?.code) {
    const nextDate = sub.next_billing_date
      ? new Date(sub.next_billing_date).toLocaleDateString("en-US", { month: "long", day: "numeric" })
      : "soon";
    const itemsList = (sub.items as { title: string }[] | null) || [];
    const itemsText = itemsList.map(i => i.title).join(", ") || "your subscription";

    steps.push({
      key: "apply_subscription",
      type: "confirm",
      question: `Apply coupon to your subscription?`,
      subtitle: `You have ${itemsText} renewing ${nextDate}. Want me to apply ${coupon.code} to your next renewal?`,
    });
    metadata.subContractId = sub.shopify_contract_id;
  }

  return { steps, metadata };
}
