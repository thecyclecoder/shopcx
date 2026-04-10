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
    case "account_linking": {
      const { buildAccountLinkingSteps } = await import("@/lib/account-linking-journey-builder");
      return buildAccountLinkingSteps(admin, workspaceId, customerId, ticketId);
    }
    case "discount_signup":
    case "marketing_signup": {
      const { buildMarketingSignupSteps } = await import("@/lib/marketing-signup-journey-builder");
      return buildMarketingSignupSteps(admin, workspaceId, customerId, ticketId);
    }
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
