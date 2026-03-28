/**
 * Build multi-step mini-site config for the discount journey.
 * Simple logic: main account only, no linked account considerations.
 */

import { createAdminClient } from "@/lib/supabase/admin";

interface DiscountStep {
  key: string;
  type: "confirm" | "radio" | "text_input" | "info";
  question: string;
  subtitle?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

export async function buildDiscountJourneySteps(
  workspaceId: string,
  customerId: string,
): Promise<{ steps: DiscountStep[]; metadata: Record<string, unknown> }> {
  const admin = createAdminClient();

  // Only look at the main customer — no linked accounts
  const { data: customer } = await admin
    .from("customers")
    .select("id, email, phone, email_marketing_status, sms_marketing_status, shopify_customer_id, retention_score")
    .eq("id", customerId)
    .single();

  if (!customer) return { steps: [], metadata: {} };

  // Get coupon info
  const { data: ws } = await admin.from("workspaces").select("vip_retention_threshold").eq("id", workspaceId).single();
  const vipThreshold = ws?.vip_retention_threshold || 85;
  const isVip = (customer.retention_score || 0) >= vipThreshold;

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

  // Get all linked IDs for subscription lookup
  let allCustomerIds = [customerId];
  const { data: links } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId);
  if (links?.[0]?.group_id) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", links[0].group_id);
    allCustomerIds = (grp || []).map(m => m.customer_id);
  }

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
    customerId,
    shopifyCustomerId: customer.shopify_customer_id,
    customerEmail: customer.email,
    couponCode: coupon?.code || null,
    couponSummary: coupon?.summary || null,
    isVip,
  };

  // Step 1: Consent (skip if already subscribed to both)
  const emailSubscribed = customer.email_marketing_status === "subscribed";
  const smsSubscribed = customer.sms_marketing_status === "subscribed";

  if (!emailSubscribed || !smsSubscribed) {
    steps.push({
      key: "consent",
      type: "confirm",
      question: "We have exclusive coupons for our email and SMS subscribers!",
      subtitle: "Would you like to sign up to get the latest deals delivered to you?",
    });
  }

  // Step 2: Phone number (only if not on file and not already SMS subscribed)
  if (!smsSubscribed && !customer.phone) {
    steps.push({
      key: "phone_input",
      type: "text_input",
      question: "What's your phone number?",
      subtitle: "We'll send you coupon alerts via text.",
      placeholder: "+1 (555) 123-4567",
    });
    metadata.needsPhone = true;
  } else if (customer.phone) {
    metadata.customerPhone = customer.phone;
  }

  // Step 3: Apply to subscription? (only if active sub + coupon exists)
  if (sub?.shopify_contract_id && coupon?.code) {
    const nextDate = sub.next_billing_date
      ? new Date(sub.next_billing_date).toLocaleDateString("en-US", { month: "long", day: "numeric" })
      : "soon";
    const itemsList = (sub.items as { title: string }[] | null) || [];
    const itemsText = itemsList.map(i => i.title).join(", ") || "your subscription";

    steps.push({
      key: "apply_subscription",
      type: "confirm",
      question: "Apply coupon to your subscription?",
      subtitle: `You have ${itemsText} renewing ${nextDate}. Want me to apply ${coupon.code} to your next renewal?`,
    });
    metadata.subContractId = sub.shopify_contract_id;
  }

  return { steps, metadata };
}
