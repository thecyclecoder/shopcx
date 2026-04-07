/**
 * Shipping Address Journey Builder
 *
 * Builds steps for confirming/updating a customer's shipping address.
 * Used during replacement order flow to validate address via EasyPost.
 *
 * Steps:
 *   1. confirm_address — show current address, ask if correct
 *   2. update_address — address form (if customer says no)
 *   3. address_confirmed — terminal confirmation
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { BuiltJourneyConfig, JourneyStep } from "@/lib/journey-step-builder";

type Admin = ReturnType<typeof createAdminClient>;

export async function buildShippingAddressSteps(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  ticketId: string,
): Promise<BuiltJourneyConfig> {
  // Get customer's current address from most recent order's shipping address
  const { data: customer } = await admin
    .from("customers")
    .select("first_name, last_name, email, phone")
    .eq("id", customerId)
    .single();

  // Get most recent order with a shipping address
  let currentAddress: Record<string, string> | null = null;
  const { data: recentOrder } = await admin
    .from("orders")
    .select("shipping_address, normalized_shipping_address")
    .eq("customer_id", customerId)
    .eq("workspace_id", workspaceId)
    .not("shipping_address", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (recentOrder?.shipping_address) {
    currentAddress = recentOrder.shipping_address as Record<string, string>;
  }

  // Also check if there's a replacement record with a pending address
  const { data: replacement } = await admin
    .from("replacements")
    .select("id, original_order_number")
    .eq("ticket_id", ticketId)
    .eq("status", "pending")
    .limit(1)
    .single();

  const steps: JourneyStep[] = [];

  if (currentAddress) {
    const addrLines = [
      currentAddress.address1 || currentAddress.street1,
      currentAddress.address2 || currentAddress.street2,
      [currentAddress.city, currentAddress.provinceCode || currentAddress.state, currentAddress.zip].filter(Boolean).join(", "),
    ].filter(Boolean).join("\n");

    steps.push({
      key: "confirm_address",
      type: "confirm",
      question: "Is this the correct shipping address?",
      subtitle: addrLines,
      options: [
        { value: "yes", label: "Yes, ship here" },
        { value: "no", label: "No, update my address" },
      ],
    });
  }

  // Address form — always included (shown if no address or customer says "no")
  steps.push({
    key: "street1",
    type: "text",
    question: "Street address",
    placeholder: "123 Main St",
  });

  steps.push({
    key: "street2",
    type: "text",
    question: "Apartment, suite, unit (optional)",
    placeholder: "Apt 4B",
  });

  steps.push({
    key: "city",
    type: "text",
    question: "City",
    placeholder: "City",
  });

  steps.push({
    key: "state",
    type: "text",
    question: "State",
    placeholder: "TX",
  });

  steps.push({
    key: "zip",
    type: "text",
    question: "ZIP code",
    placeholder: "75001",
  });

  return {
    codeDriven: true,
    multiStep: true,
    steps,
    metadata: {
      currentAddress,
      customerName: customer ? `${customer.first_name} ${customer.last_name}` : null,
      customerEmail: customer?.email || null,
      replacementId: replacement?.id || null,
      originalOrderNumber: replacement?.original_order_number || null,
    },
  };
}
