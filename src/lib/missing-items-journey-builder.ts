/**
 * Missing Items Journey Builder
 *
 * Two-step flow:
 *   Step 1 (item_accounting): For EACH item, what happened? Per-item radio
 *     - Received and OK (default — no action)
 *     - Item is missing
 *     - Damaged or unusable (melted, discolored, broken seal, stuck together)
 *     - Wrong item — got something different than ordered
 *   Step 2 (item_accounting): For items marked missing/damaged/wrong, how many?
 *
 * If every item is "received and OK", we close out as no replacement needed.
 * Otherwise we produce a replacement plan keyed by reason — the orchestrator's
 * reply can mention common causes (heat for "damaged", carrier for "missing",
 * etc.) based on which reasons appear in the result.
 *
 * Old shape was a single "select all that had issues" checkbox — Angelyna
 * Reggiani (ticket 0428c8a9) revealed the gap: she received the box but
 * the tablets were unusable, so she correctly didn't tick "missing"
 * boxes, and the journey concluded "all items received OK". The per-item
 * radio with explicit reason eliminates that mismatch.
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

  // Step 1: Per-item reason picker. The renderer groups by `item_N:`
  // prefix and shows a radio per item.
  const REASONS: { value: "ok" | "missing" | "damaged" | "wrong"; label: string }[] = [
    { value: "ok",      label: "Received and OK" },
    { value: "missing", label: "Item is missing from the box" },
    { value: "damaged", label: "Damaged or unusable (melted, discolored, stuck together, broken seal)" },
    { value: "wrong",   label: "Wrong item — I got something different than I ordered" },
  ];
  const reasonGroups = lineItems.map((item, idx) => ({
    key: `item_${idx}`,
    title: `${item.title}${item.quantity > 1 ? ` (x${item.quantity})` : ""}`,
    quantity: item.quantity,
    options: REASONS.map((r) => ({ value: `item_${idx}:${r.value}`, label: r.label })),
  }));
  steps.push({
    key: "select_items",
    type: "item_accounting",
    question: "What happened with each item?",
    subtitle: "Pick the option that best matches for each item. If everything arrived fine, leave each one on 'Received and OK'.",
    options: reasonGroups.flatMap((g) => g.options),
  });

  // Step 2: Quantity per affected item. Only renders entries whose
  // step-1 pick wasn't "ok". The frontend already filters by step-1
  // response so we ship the full option set here.
  const qtyGroups = lineItems.map((item, idx) => {
    const options: { value: string; label: string }[] = [];
    for (let n = 1; n <= item.quantity; n++) {
      options.push({
        value: `item_${idx}:${n}`,
        label: n === item.quantity && item.quantity > 1 ? `All ${n}` : String(n),
      });
    }
    return { key: `item_${idx}`, title: item.title, quantity: item.quantity, options };
  });
  steps.push({
    key: "item_accounting",
    type: "item_accounting",
    question: "How many of each were affected?",
    subtitle: "Pick the quantity for each item you flagged above.",
    options: qtyGroups.flatMap((g) => g.options),
  });

  return {
    codeDriven: true,
    multiStep: true,
    steps,
    metadata: {
      orderId: order.id,
      orderNumber: order.order_number,
      lineItems,
      reasonGroups,
      qtyGroups,
      replacementId: replacement?.id || null,
    },
  };
}

/**
 * Parse the two-step journey response into replacement items keyed
 * by reason.
 *
 *   selectResponse format:      "item_0:damaged,item_1:ok,item_2:missing"
 *   accountingResponse format:  "item_0:2,item_2:1"
 *
 * Returns:
 *   - allReceived: true when every item picked "ok"
 *   - replacementItems: per-item reason + qty
 *   - reasonsPresent: set of reasons (drives orchestrator reply context)
 *   - summary: human-readable rollup for the system log
 */
type ItemReason = "ok" | "missing" | "damaged" | "wrong";

export interface ParsedReplacementItem {
  title: string;
  quantity: number;
  reason: Exclude<ItemReason, "ok">;
  sku?: string;
  variantId?: string;
}

export function parseItemAccounting(
  selectResponse: string,
  accountingResponse: string,
  lineItems: OrderLineItem[],
): {
  allReceived: boolean;
  replacementItems: ParsedReplacementItem[];
  reasonsPresent: Set<Exclude<ItemReason, "ok">>;
  summary: string;
} {
  // Parse step 1 — per-item reason
  const reasonByIdx = new Map<number, Exclude<ItemReason, "ok">>();
  for (const part of selectResponse.split(",").map(s => s.trim()).filter(Boolean)) {
    const [key, val] = part.split(":");
    if (!key || !val) continue;
    const idx = parseInt(key.replace("item_", ""));
    if (isNaN(idx)) continue;
    const r = val.trim() as ItemReason;
    // BACK-COMPAT: a bare numeric value here (e.g. "0,2,4" — the
    // legacy checkbox shape) means "this item had an issue" with
    // no reason. Treat as "damaged" so we don't lose the report.
    if (r === "ok") continue;
    if (r === "missing" || r === "damaged" || r === "wrong") {
      reasonByIdx.set(idx, r);
    }
  }
  // BACK-COMPAT fallback: if selectResponse is just digit indices
  // ("0,2,4"), treat each as "damaged".
  if (reasonByIdx.size === 0 && /^[\d,\s]+$/.test(selectResponse) && selectResponse.trim()) {
    for (const s of selectResponse.split(",").map(x => x.trim())) {
      const idx = parseInt(s);
      if (!isNaN(idx)) reasonByIdx.set(idx, "damaged");
    }
  }

  if (reasonByIdx.size === 0) {
    return {
      allReceived: true,
      replacementItems: [],
      reasonsPresent: new Set(),
      summary: "All items received OK",
    };
  }

  // Parse step 2 — quantities. Default to 1 if absent (one-item subs
  // skip the picker in practice).
  const qtyByIdx = new Map<number, number>();
  for (const part of accountingResponse.split(",").map(s => s.trim()).filter(Boolean)) {
    const [key, qtyStr] = part.split(":");
    const idx = parseInt((key || "").replace("item_", ""));
    const qty = parseInt(qtyStr || "1");
    if (!isNaN(idx) && !isNaN(qty) && qty > 0) qtyByIdx.set(idx, qty);
  }

  const replacementItems: ParsedReplacementItem[] = [];
  const reasonsPresent = new Set<Exclude<ItemReason, "ok">>();
  for (const [idx, reason] of reasonByIdx.entries()) {
    const item = lineItems[idx];
    if (!item) continue;
    const qty = qtyByIdx.get(idx) ?? Math.min(item.quantity, 1);
    replacementItems.push({
      title: item.title,
      quantity: qty,
      reason,
      sku: item.sku,
      variantId: item.variant_id,
    });
    reasonsPresent.add(reason);
  }

  const summary = replacementItems
    .map(i => `${i.quantity}x ${i.title} (${i.reason})`)
    .join(", ");

  return {
    allReceived: replacementItems.length === 0,
    replacementItems,
    reasonsPresent,
    summary: replacementItems.length === 0 ? "All items received OK" : summary,
  };
}
