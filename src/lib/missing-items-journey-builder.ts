/**
 * Missing Items Journey Builder
 *
 * Builds a per-item accounting form so the customer declares the status
 * of each item: Received OK, Damaged, or Missing.
 *
 * For items with quantity > 1, options account for partial receipt.
 * The system fact-checks against the order — if everything is received,
 * it closes gracefully. Only damaged/missing items get replaced, with
 * exact quantities (not the full line item).
 *
 * Steps:
 *   1. item_accounting — per-item status (received/damaged/missing)
 *      Response format: "item_0:received,item_1:1_missing,item_2:damaged"
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

/**
 * Build options for a single line item based on its quantity.
 * qty=1: Received OK / Damaged / Missing
 * qty=2: Received 2 / 1 Received + 1 Missing / 1 Received + 1 Damaged / Both Missing / Both Damaged
 * qty=3+: similar pattern
 */
function buildItemOptions(item: OrderLineItem, idx: number): { value: string; label: string }[] {
  const prefix = `item_${idx}`;
  const qty = item.quantity;

  if (qty === 1) {
    return [
      { value: `${prefix}:received`, label: "Received OK" },
      { value: `${prefix}:damaged`, label: "Damaged" },
      { value: `${prefix}:missing`, label: "Missing" },
    ];
  }

  // qty >= 2: build combinations
  const options: { value: string; label: string }[] = [];

  // All received
  options.push({ value: `${prefix}:received`, label: `Received all ${qty}` });

  // Partial missing/damaged for each possible count
  for (let bad = 1; bad < qty; bad++) {
    const good = qty - bad;
    options.push({
      value: `${prefix}:${bad}_missing`,
      label: `Received ${good}, ${bad} missing`,
    });
    options.push({
      value: `${prefix}:${bad}_damaged`,
      label: `Received ${good}, ${bad} damaged`,
    });
  }

  // All missing / all damaged
  options.push({ value: `${prefix}:${qty}_missing`, label: `All ${qty} missing` });
  options.push({ value: `${prefix}:${qty}_damaged`, label: `All ${qty} damaged` });

  return options;
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
  // Find the replacement record to get the original order
  const { data: replacement } = await admin
    .from("replacements")
    .select("id, original_order_id, original_order_number")
    .eq("ticket_id", ticketId)
    .in("status", ["pending", "address_confirmed"])
    .limit(1)
    .single();

  let orderId = replacement?.original_order_id;

  // If no replacement record, check playbook context for identified order
  if (!orderId) {
    const { data: ticket } = await admin
      .from("tickets")
      .select("playbook_context")
      .eq("id", ticketId)
      .single();
    const ctx = (ticket?.playbook_context || {}) as Record<string, unknown>;
    orderId = ctx.identified_order_id as string | undefined;
  }

  // Fallback: most recent delivered order
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
      codeDriven: true,
      multiStep: false,
      steps: [{
        key: "no_order",
        type: "info",
        question: "We couldn't find a recent delivered order to check. Please contact us with your order details.",
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

  const lineItems: OrderLineItem[] = (order.line_items as OrderLineItem[])
    .filter(item => {
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

  // Enrich with variant titles (e.g. "Amazing Coffee" → "Amazing Coffee — Hazelnut")
  const enrichedItems = await enrichVariantTitles(admin, workspaceId, lineItems);

  // Build per-item accounting step
  // Each item gets a group of radio options
  const itemGroups = enrichedItems.map((item, idx) => ({
    key: `item_${idx}`,
    title: `${item.title}${item.quantity > 1 ? ` (x${item.quantity})` : ""}`,
    options: buildItemOptions(item, idx),
  }));

  const steps: JourneyStep[] = [];

  steps.push({
    key: "item_accounting",
    type: "item_accounting",
    question: "Help us understand what happened with each item",
    subtitle: "Select the status for each item in your order.",
    options: itemGroups.flatMap(g => g.options), // Flat list for compatibility
    // The item_accounting type renderer will group by prefix
  });

  return {
    codeDriven: true,
    multiStep: true,
    steps,
    metadata: {
      orderId: order.id,
      orderNumber: order.order_number,
      lineItems: enrichedItems, // With variant titles for display AND completion parsing
      itemGroups, // Used by the mini-site to render grouped radios
      replacementId: replacement?.id || null,
    },
  };
}

/**
 * Parse item_accounting response and determine what needs replacing.
 * Returns: { allReceived, replacementItems, summary }
 */
export function parseItemAccounting(
  response: string,
  lineItems: OrderLineItem[],
): {
  allReceived: boolean;
  replacementItems: { title: string; quantity: number; type: "missing" | "damaged"; sku?: string; variantId?: string }[];
  summary: string;
} {
  // Response format: "item_0:received,item_1:1_missing,item_2:damaged"
  const parts = response.split(",").map(s => s.trim());
  const replacementItems: { title: string; quantity: number; type: "missing" | "damaged"; sku?: string; variantId?: string }[] = [];

  for (const part of parts) {
    const [key, status] = part.split(":");
    if (!key || !status) continue;

    const idx = parseInt(key.replace("item_", ""));
    const item = lineItems[idx];
    if (!item) continue;

    if (status === "received") continue;

    if (status === "damaged" || status === "missing") {
      // qty=1 items
      replacementItems.push({
        title: item.title,
        quantity: 1,
        type: status as "missing" | "damaged",
        sku: item.sku,
        variantId: item.variant_id,
      });
    } else {
      // Parse "N_missing" or "N_damaged"
      const match = status.match(/^(\d+)_(missing|damaged)$/);
      if (match) {
        const qty = parseInt(match[1]);
        const type = match[2] as "missing" | "damaged";
        replacementItems.push({
          title: item.title,
          quantity: qty,
          type,
          sku: item.sku,
          variantId: item.variant_id,
        });
      }
    }
  }

  const allReceived = replacementItems.length === 0;
  const summary = allReceived
    ? "All items received OK"
    : replacementItems.map(i => `${i.quantity}x ${i.title} (${i.type})`).join(", ");

  return { allReceived, replacementItems, summary };
}
