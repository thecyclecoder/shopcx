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
  type: "checklist" | "confirm" | "text" | "select" | "single_choice" | "phone" | "info" | "item_accounting" | "address_form";
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
    case "shipping_address":
    case "address_change": {
      const { buildShippingAddressSteps } = await import("@/lib/shipping-address-journey-builder");
      return buildShippingAddressSteps(admin, workspaceId, customerId, ticketId);
    }
    case "missing_items": {
      const { buildMissingItemsSteps } = await import("@/lib/missing-items-journey-builder");
      return buildMissingItemsSteps(admin, workspaceId, customerId, ticketId);
    }
    case "select_subscription": {
      const { buildSelectSubscriptionSteps } = await import("@/lib/select-subscription-journey-builder");
      return buildSelectSubscriptionSteps(admin, workspaceId, customerId, ticketId);
    }
    case "crisis_tier1": {
      const { buildCrisisTier1Steps } = await import("@/lib/crisis-journey-builder");
      return buildCrisisTier1Steps(admin, workspaceId, customerId, ticketId);
    }
    case "crisis_tier2": {
      const { buildCrisisTier2Steps } = await import("@/lib/crisis-journey-builder");
      return buildCrisisTier2Steps(admin, workspaceId, customerId, ticketId);
    }
    case "crisis_tier3": {
      const { buildCrisisTier3Steps } = await import("@/lib/crisis-journey-builder");
      return buildCrisisTier3Steps(admin, workspaceId, customerId, ticketId);
    }
    default:
      return { codeDriven: true, multiStep: false, steps: [] };
  }
}

// ── Account Linking ──

async function buildAccountLinkingSteps(
  admin: Admin, workspaceId: string, customerId: string, ticketId: string,
): Promise<BuiltJourneyConfig> {
  const { findUnlinkedMatches } = await import("@/lib/account-matching");
  const unlinked = await findUnlinkedMatches(workspaceId, customerId, admin);

  // Get existing group ID for metadata
  const { data: existingLinks } = await admin.from("customer_links")
    .select("group_id").eq("customer_id", customerId);
  const groupId = existingLinks?.[0]?.group_id || null;

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
// Delegates to cancel-journey-builder.ts — single source of truth

async function buildCancelSteps(
  _admin: Admin, workspaceId: string, customerId: string, ticketId?: string,
): Promise<BuiltJourneyConfig & { cancelJourney: boolean }> {
  const { buildCancelJourneySteps } = await import("@/lib/cancel-journey-builder");
  const result = await buildCancelJourneySteps(workspaceId, customerId, ticketId || "");

  return {
    codeDriven: true,
    cancelJourney: true,
    multiStep: result.steps.length > 1,
    steps: result.steps as JourneyStep[],
    metadata: result.metadata as unknown as Record<string, unknown>,
  } as BuiltJourneyConfig & { cancelJourney: boolean };
}
