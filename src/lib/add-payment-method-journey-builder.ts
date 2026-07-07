/**
 * Add Payment Method Journey Builder
 *
 * One-step flow — customer with no vaulted card enters one via Braintree
 * Hosted Fields in the mini-site. Follows the shape of
 * shipping-address-journey-builder.ts (single-step, code-driven, config in the
 * `journey_definitions` row is empty — this builder produces the shape).
 *
 * Steps:
 *   1. add_card — payment_method step, mounts Braintree Hosted Fields. The
 *      mini-site fetches a Braintree client token via /api/journey/[token]/
 *      client-token (mirrors the portal's braintreeClientToken handler, but
 *      auth'd by the journey token instead of a portal session).
 *
 * The vault + savePaymentMethod + migrate-to-internal sequence is wired in
 * Phase 2 (extracted from src/lib/portal/handlers/payment-method-update.ts
 * so both callers share one code path). The completion signal back to the
 * awaiting playbook is wired in Phase 3.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { BuiltJourneyConfig, JourneyStep } from "@/lib/journey-step-builder";

type Admin = ReturnType<typeof createAdminClient>;

export async function buildAddPaymentMethodSteps(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  _ticketId: string,
): Promise<BuiltJourneyConfig> {
  const { data: customer } = await admin
    .from("customers")
    .select("first_name, last_name, email")
    .eq("id", customerId)
    .eq("workspace_id", workspaceId)
    .single();

  const cardholderName = customer
    ? [customer.first_name, customer.last_name].filter(Boolean).join(" ")
    : "";

  const steps: JourneyStep[] = [
    {
      key: "add_card",
      type: "payment_method",
      question: "Add a payment method",
      subtitle: "Enter a card to save on file. We'll use it for your future orders.",
    },
  ];

  return {
    codeDriven: true,
    multiStep: false,
    steps,
    metadata: {
      cardholderName,
      customerEmail: customer?.email || null,
    },
  };
}
