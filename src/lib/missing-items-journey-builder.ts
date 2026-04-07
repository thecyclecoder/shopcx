/**
 * Missing Items Journey Builder
 *
 * Two-step flow:
 *   Step 1 (checklist): Select which items had issues (unselected = received fine)
 *   Step 2 (item_accounting): For each selected item, how many were damaged/missing?
 *
 * If customer selects nothing in step 1, all items received = no replacement.
 * Step 2 only shows items from step 1, with simple quantity options.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { BuiltJourneyConfig, JourneyStep } from "@/lib/journey-step-builder";

type Admin = ReturnType<typeof createAdminClient>;

export interface OrderLineItem {
  title: string;
  quantity: number;
  sku?: string;
  variant_id?: string;
}

/** Resolve variant titles from products table */
async function enrichVariantTitles(
  admin: Admin, workspaceId: string, items: OrderLineItem[],
): Promise<OrderLineItem[]> {
  const variantIds = items.map(i => i.variant_id).filter(Boolean);
  if (variantIds.length === 0) return items;

  const { data: products } = await admin.from("products")
    .select("variants")
    .eq("workspace_id", workspaceId);

  const variantMap = new Map<string, string>();
  for (const p of products || []) {
    for (const v of (p.variants as { id: string; title: string }[]) || []) {
      variantMap.set(String(v.id), v.title);
    }
  }

  return items.map(item => {
    const variantTitle = item.variant_id ? variantMap.get(item.variant_id) : null;
    if (variantTitle && variantTitle !== "Default Title") {
      return { ...item, title: `${item.title} — ${variantTitle}` };
    }
    return item;
  });
}

export async function buildMissingItemsSteps(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  ticketId: string,
): Promise<BuiltJourneyConfig> {
  // Find the order from replacement record or playbook context
  const { data: replacement } = await admin
    .from("replacements")
    .select("id, original_order_id, original_order_number")
    .eq("ticket_id", ticketId)
    .in("status", ["pending", "address_confirmed"])
    .limit(1)
    .single();

  let orderId = replacement?.original_order_id;

  if (!orderId) {
    const { data: ticket } = await admin
      .from("tickets")
      .select("playbook_context")
      .eq("id", ticketId)
      .single();
    const ctx = (ticket?.playbook_context || {}) as Record<string, unknown>;
    orderId = ctx.identified_order_id as string | undefined;
  }

  if (!orderId) {
    const { data: recentOrder } = await admin
      .from("orders")
      .select("id")
      .eq("customer_id", customerId)
      .eq("workspace_id", workspaceId)
      .eq("delivery_status", "delivered")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    orderId = recentOrder?.id;
  }

  if (!orderId) {
    return {
      codeDriven: true, multiStep: false,
      steps: [{ key: "no_order", type: "info", question: "We couldn't find a recent delivered order to check. Please contact us with your order details.", isTerminal: true }],
    };
  }

  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, line_items")
    .eq("id", orderId)
    .single();

  if (!order?.line_items) {
    return {
      codeDriven: true, multiStep: false,
      steps: [{ key: "no_items", type: "info", question: "We couldn't find items for this order. Please contact us for assistance.", isTerminal: true }],
    };
  }

  const rawItems: OrderLineItem[] = (order.line_items as OrderLineItem[])
    .filter(item => {
      const t = item.title.toLowerCase();
      return !t.includes("shipping protection") && !t.includes("insure");
    });

  if (rawItems.length === 0) {
    return {
      codeDriven: true, multiStep: false,
      steps: [{ key: "no_items", type: "info", question: "No replaceable items found for this order.", isTerminal: true }],
    };
  }

  const lineItems = await enrichVariantTitles(admin, workspaceId, rawItems);

  const steps: JourneyStep[] = [];

  // Step 1: Checklist — which items had issues?
  steps.push({
    key: "select_items",
    type: "checklist",
    question: "Which items had an issue?",
    subtitle: "Select all items that were missing or damaged. Items you don't select will be marked as received.",
    options: lineItems.map((item, idx) => ({
      value: String(idx),
      label: `${item.title}${item.quantity > 1 ? ` (x${item.quantity})` : ""}`,
    })),
  });

  // Step 2: item_accounting — for selected items, how many?
  // Options are built per-item: "1 damaged/missing", "2 damaged/missing", etc.
  const itemGroups = lineItems.map((item, idx) => {
    const options: { value: string; label: string }[] = [];
    for (let n = 1; n <= item.quantity; n++) {
      options.push({
        value: `item_${idx}:${n}`,
        label: n === item.quantity && item.quantity > 1
          ? `All ${n} damaged/missing`
          : `${n} damaged/missing`,
      });
    }
    return { key: `item_${idx}`, title: item.title, quantity: item.quantity, options };
  });

  // Flat options for the step (renderer will group by prefix)
  const allOptions = itemGroups.flatMap(g => g.options);

  steps.push({
    key: "item_accounting",
    type: "item_accounting",
    question: "How many of each item were damaged or missing?",
    subtitle: "Select the quantity for each affected item.",
    options: allOptions,
  });

  return {
    codeDriven: true,
    multiStep: true,
    steps,
    metadata: {
      orderId: order.id,
      orderNumber: order.order_number,
      lineItems,
      itemGroups,
      replacementId: replacement?.id || null,
    },
  };
}

/**
 * Parse the two-step journey response into replacement items.
 * Step 1 response: "0,2,4" (selected item indices)
 * Step 2 response: "item_0:1,item_2:2,item_4:1" (quantities)
 */
export function parseItemAccounting(
  selectResponse: string,
  accountingResponse: string,
  lineItems: OrderLineItem[],
): {
  allReceived: boolean;
  replacementItems: { title: string; quantity: number; type: "damaged_or_missing"; sku?: string; variantId?: string }[];
  summary: string;
} {
  const selectedIndices = selectResponse.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));

  if (selectedIndices.length === 0) {
    return { allReceived: true, replacementItems: [], summary: "All items received OK" };
  }

  const replacementItems: { title: string; quantity: number; type: "damaged_or_missing"; sku?: string; variantId?: string }[] = [];

  // Parse accounting response
  const parts = accountingResponse.split(",").map(s => s.trim());
  for (const part of parts) {
    const [key, qtyStr] = part.split(":");
    if (!key || !qtyStr) continue;
    const idx = parseInt(key.replace("item_", ""));
    const qty = parseInt(qtyStr);
    const item = lineItems[idx];
    if (!item || isNaN(qty) || qty <= 0) continue;

    replacementItems.push({
      title: item.title,
      quantity: qty,
      type: "damaged_or_missing",
      sku: item.sku,
      variantId: item.variant_id,
    });
  }

  return {
    allReceived: replacementItems.length === 0,
    replacementItems,
    summary: replacementItems.length === 0
      ? "All items received OK"
      : replacementItems.map(i => `${i.quantity}x ${i.title}`).join(", "),
  };
}
