/**
 * Missing Items Journey Builder
 *
 * Builds a checklist of order items so the customer can select
 * which items were missing or damaged. Excludes Shipping Protection.
 *
 * Steps:
 *   1. select_items — checklist of order items
 *   2. item_condition — for each selected item: missing or damaged?
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { BuiltJourneyConfig, JourneyStep } from "@/lib/journey-step-builder";

type Admin = ReturnType<typeof createAdminClient>;

export async function buildMissingItemsSteps(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  ticketId: string,
): Promise<BuiltJourneyConfig> {
  // Find the replacement record to get the original order
  const { data: replacement } = await admin
    .from("replacements")
    .select("id, original_order_id, original_order_number")
    .eq("ticket_id", ticketId)
    .in("status", ["pending", "address_confirmed"])
    .limit(1)
    .single();

  let orderId = replacement?.original_order_id;

  // If no replacement record, find most recent order for customer
  if (!orderId) {
    const { data: recentOrder } = await admin
      .from("orders")
      .select("id")
      .eq("customer_id", customerId)
      .eq("workspace_id", workspaceId)
      .eq("fulfillment_status", "FULFILLED")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    orderId = recentOrder?.id;
  }

  if (!orderId) {
    return {
      codeDriven: true,
      multiStep: false,
      steps: [{
        key: "no_order",
        type: "info",
        question: "We couldn't find a recent order to check. Please contact us with your order details.",
        isTerminal: true,
      }],
    };
  }

  // Get order line items
  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, line_items")
    .eq("id", orderId)
    .single();

  if (!order?.line_items) {
    return {
      codeDriven: true,
      multiStep: false,
      steps: [{
        key: "no_items",
        type: "info",
        question: "We couldn't find items for this order. Please contact us for assistance.",
        isTerminal: true,
      }],
    };
  }

  const lineItems = (order.line_items as { title: string; quantity: number; sku?: string }[])
    .filter(item => {
      // Exclude Shipping Protection and similar non-product items
      const titleLower = item.title.toLowerCase();
      return !titleLower.includes("shipping protection") && !titleLower.includes("insure");
    });

  if (lineItems.length === 0) {
    return {
      codeDriven: true,
      multiStep: false,
      steps: [{
        key: "no_items",
        type: "info",
        question: "No replaceable items found for this order.",
        isTerminal: true,
      }],
    };
  }

  const steps: JourneyStep[] = [];

  // Step 1: Select which items are missing/damaged
  steps.push({
    key: "select_items",
    type: "checklist",
    question: "Which items were missing or damaged?",
    subtitle: "Select all that apply.",
    options: lineItems.map((item, idx) => ({
      value: String(idx),
      label: `${item.title}${item.quantity > 1 ? ` (x${item.quantity})` : ""}`,
    })),
  });

  // Step 2: For each item, ask if missing or damaged
  steps.push({
    key: "item_condition",
    type: "single_choice",
    question: "Were these items missing or damaged?",
    subtitle: "This helps us process your replacement correctly.",
    options: [
      { value: "missing", label: "Missing — not in the package" },
      { value: "damaged", label: "Damaged — arrived broken or unusable" },
      { value: "both", label: "Some missing, some damaged" },
    ],
  });

  return {
    codeDriven: true,
    multiStep: true,
    steps,
    metadata: {
      orderId: order.id,
      orderNumber: order.order_number,
      lineItems,
      replacementId: replacement?.id || null,
    },
  };
}
