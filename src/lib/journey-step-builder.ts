/**
 * Journey Step Builder
 *
 * Builds interactive steps dynamically for code-driven journeys.
 * Used by both the mini-site GET API and the chat embedded form system.
 * One source of truth per journey type — never separately maintained.
 */

import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface JourneyStep {
  key: string;
  type: "checklist" | "confirm" | "text" | "select" | "phone" | "info";
  question: string;
  subtitle?: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  isTerminal?: boolean;
}

export interface BuiltJourneyConfig {
  codeDriven: boolean;
  multiStep: boolean;
  steps: JourneyStep[];
  metadata?: Record<string, unknown>;
}

/**
 * Build steps for any code-driven journey based on journey type.
 * Returns the config with dynamically generated steps.
 */
export async function buildJourneySteps(
  workspaceId: string,
  journeyType: string,
  customerId: string,
  ticketId: string,
): Promise<BuiltJourneyConfig> {
  const admin = createAdminClient();

  switch (journeyType) {
    case "account_linking":
      return buildAccountLinkingSteps(admin, workspaceId, customerId, ticketId);
    case "discount_signup":
    case "marketing_signup":
      return buildMarketingSignupSteps(admin, workspaceId, customerId, ticketId);
    case "cancel":
    case "cancellation":
    case "cancel_subscription":
      return buildCancelSteps(admin, workspaceId, customerId, ticketId);
    default:
      return { codeDriven: true, multiStep: false, steps: [] };
  }
}

// ── Account Linking ──

async function buildAccountLinkingSteps(
  admin: Admin, workspaceId: string, customerId: string, ticketId: string,
): Promise<BuiltJourneyConfig> {
  const { data: cust } = await admin.from("customers")
    .select("id, email, first_name, last_name, phone")
    .eq("id", customerId).single();

  if (!cust) return { codeDriven: true, multiStep: false, steps: [] };

  // Find already-linked accounts
  const { data: existingLinks } = await admin.from("customer_links")
    .select("group_id").eq("customer_id", cust.id);
  const groupId = existingLinks?.[0]?.group_id || null;

  let alreadyLinkedIds: string[] = [];
  if (groupId) {
    const { data: members } = await admin.from("customer_links")
      .select("customer_id").eq("group_id", groupId);
    alreadyLinkedIds = (members || []).map(m => m.customer_id);
  }

  // Find rejected
  const { data: rejections } = await admin.from("customer_link_rejections")
    .select("rejected_customer_id").eq("customer_id", cust.id);
  const rejectedIds = (rejections || []).map(r => r.rejected_customer_id);

  // Find potential matches by name, phone, or email prefix
  const conditions: string[] = [];
  if (cust.first_name && cust.last_name) {
    conditions.push(`and(first_name.eq.${cust.first_name},last_name.eq.${cust.last_name})`);
  }
  if (cust.phone) conditions.push(`phone.eq.${cust.phone}`);
  const emailLocal = cust.email?.split("@")[0];
  if (emailLocal) conditions.push(`email.ilike.${emailLocal}@%`);

  if (!conditions.length) return { codeDriven: true, multiStep: false, steps: [] };

  const { data: matches } = await admin.from("customers")
    .select("id, email")
    .eq("workspace_id", workspaceId)
    .neq("id", cust.id)
    .neq("email", cust.email)
    .or(conditions.join(","))
    .limit(10);

  const unlinked = (matches || []).filter(m =>
    !alreadyLinkedIds.includes(m.id) && !rejectedIds.includes(m.id)
  );

  if (unlinked.length === 0) {
    return { codeDriven: true, multiStep: false, steps: [{
      key: "no_matches",
      type: "info",
      question: "Your account looks good — no additional profiles found!",
      isTerminal: true,
    }] };
  }

  return {
    codeDriven: true,
    multiStep: true,
    steps: [
      {
        key: "link_accounts",
        type: "checklist",
        question: "Select all email addresses that belong to you",
        subtitle: "We found these accounts that might be yours. Linking them helps us serve you better.",
        options: unlinked.map(m => ({ value: m.id, label: m.email })),
      },
      {
        key: "confirm_link",
        type: "confirm",
        question: "Confirm linking these accounts?",
        subtitle: "This will combine your order history and subscriptions into one profile.",
        options: [
          { value: "yes", label: "Yes, link them" },
          { value: "no", label: "No, these aren't mine" },
        ],
      },
    ],
    metadata: { unlinkedMatches: unlinked, existingGroupId: groupId },
  };
}

// ── Marketing Signup ──

async function buildMarketingSignupSteps(
  admin: Admin, workspaceId: string, customerId: string, _ticketId: string,
): Promise<BuiltJourneyConfig> {
  const { data: customer } = await admin.from("customers")
    .select("email, phone, email_marketing_status, sms_marketing_status, shopify_customer_id")
    .eq("id", customerId).single();

  if (!customer) return { codeDriven: true, multiStep: false, steps: [] };

  const emailSubscribed = customer.email_marketing_status === "subscribed";
  const smsSubscribed = customer.sms_marketing_status === "subscribed";

  // Already subscribed to both
  if (emailSubscribed && smsSubscribed) {
    // Check for available coupons
    const { data: coupons } = await admin.from("coupon_mappings")
      .select("code, summary").eq("workspace_id", workspaceId).eq("ai_enabled", true).limit(1);

    if (coupons?.length) {
      return { codeDriven: true, multiStep: false, steps: [{
        key: "already_subscribed",
        type: "info",
        question: `You're already subscribed! Use code ${coupons[0].code} for ${coupons[0].summary}.`,
        isTerminal: true,
      }] };
    }
    return { codeDriven: true, multiStep: false, steps: [{
      key: "already_subscribed",
      type: "info",
      question: "You're already subscribed to our emails and SMS. You'll be the first to know about our deals!",
      isTerminal: true,
    }] };
  }

  const steps: JourneyStep[] = [];

  // Consent step
  steps.push({
    key: "consent",
    type: "confirm",
    question: "Sign up for exclusive coupons and deals?",
    subtitle: emailSubscribed
      ? "Add SMS to get instant notifications about new deals."
      : smsSubscribed
        ? "Add email to get detailed offers and announcements."
        : "Subscribe to email and SMS for the best deals.",
    options: [
      { value: "yes", label: "Yes, sign me up!" },
      { value: "no", label: "No thanks" },
    ],
  });

  // Phone number step (if no phone on file and not SMS subscribed)
  if (!smsSubscribed && !customer.phone) {
    steps.push({
      key: "phone",
      type: "phone",
      question: "What's your phone number for SMS deals?",
      placeholder: "(555) 555-5555",
    });
  }

  return { codeDriven: true, multiStep: true, steps };
}

// ── Cancel Journey Steps ──

async function buildCancelSteps(
  admin: Admin, workspaceId: string, customerId: string, ticketId?: string,
): Promise<BuiltJourneyConfig & { cancelJourney: boolean }> {
  // Fetch customer's active subscriptions
  const { data: subs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, created_at")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("status", ["active", "paused"])
    .order("created_at", { ascending: false });

  // Also check linked customer profiles
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).single();
  let allSubs = subs || [];
  if (link) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    const linkedIds = (grp || []).map(g => g.customer_id).filter(id => id !== customerId);
    if (linkedIds.length > 0) {
      const { data: linkedSubs } = await admin.from("subscriptions")
        .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, created_at")
        .eq("workspace_id", workspaceId)
        .in("customer_id", linkedIds)
        .in("status", ["active", "paused"]);
      allSubs = [...allSubs, ...(linkedSubs || [])];
    }
  }

  // Calculate first-renewal detection
  const subscriptionData = allSubs.map(s => {
    const ageDays = Math.floor((Date.now() - new Date(s.created_at).getTime()) / 86400000);
    const intervalDays = s.billing_interval === "MONTH" ? s.billing_interval_count * 30
      : s.billing_interval === "WEEK" ? s.billing_interval_count * 7
      : s.billing_interval_count * 30;
    const isFirstRenewal = ageDays < intervalDays;
    const items = (s.items as { title?: string; variant_title?: string; image_url?: string }[] || []).map(i => ({
      title: i.title || "Product",
      variant_title: i.variant_title || null,
      image_url: i.image_url || null,
    }));
    return {
      id: s.id,
      contractId: s.shopify_contract_id,
      status: s.status,
      items,
      billingInterval: s.billing_interval,
      billingIntervalCount: s.billing_interval_count,
      nextBillingDate: s.next_billing_date,
      isFirstRenewal,
      subscriptionAgeDays: ageDays,
    };
  });

  return {
    codeDriven: true,
    cancelJourney: true,
    multiStep: false,
    steps: [],
    metadata: {
      subscriptions: subscriptionData,
      selectedSubscriptionId: subscriptionData[0]?.id || null,
    },
    ticketId,
  } as BuiltJourneyConfig & { cancelJourney: boolean };
}
