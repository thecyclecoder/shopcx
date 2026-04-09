/**
 * Select Subscription Journey Builder
 *
 * Lightweight picker — shows subscription cards, customer picks one.
 * Returns the subscription ID to the calling workflow/playbook.
 * Only used when there are 2+ applicable subscriptions.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { BuiltJourneyConfig, JourneyStep } from "@/lib/journey-step-builder";

type Admin = ReturnType<typeof createAdminClient>;

interface SubOption {
  id: string;
  contractId: string;
  status: string;
  items: { title: string; quantity: number }[];
  nextBillingDate: string | null;
}

export async function buildSelectSubscriptionSteps(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  ticketId: string,
  filterStatuses?: string[], // e.g. ["active"] or ["paused", "cancelled"]
): Promise<BuiltJourneyConfig> {
  // Get all subscriptions across linked accounts
  const linkedIds = [customerId];
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
  if (link) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    for (const g of grp || []) if (!linkedIds.includes(g.customer_id)) linkedIds.push(g.customer_id);
  }

  const statusFilter = filterStatuses || ["active"];
  const { data: subs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, status, items, next_billing_date")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds)
    .in("status", statusFilter)
    .order("created_at", { ascending: false });

  if (!subs?.length) {
    return {
      codeDriven: true, multiStep: false,
      steps: [{ key: "no_subs", type: "info", question: "No matching subscriptions found.", isTerminal: true }],
    };
  }

  // Enrich item titles with variant names
  const { data: products } = await admin.from("products").select("variants").eq("workspace_id", workspaceId);
  const variantMap = new Map<string, string>();
  for (const p of products || []) {
    for (const v of (p.variants as { id: string; title: string }[]) || []) {
      if (v.title && v.title !== "Default Title") variantMap.set(String(v.id), v.title);
    }
  }

  const options: SubOption[] = subs.map(s => {
    const items = ((s.items as { title: string; quantity: number; variant_id?: string }[]) || [])
      .filter(i => !i.title.toLowerCase().includes("shipping protection"))
      .map(i => {
        const vTitle = i.variant_id ? variantMap.get(i.variant_id) : null;
        return { title: vTitle ? `${i.title} — ${vTitle}` : i.title, quantity: i.quantity };
      });
    return {
      id: s.id,
      contractId: s.shopify_contract_id,
      status: s.status,
      items,
      nextBillingDate: s.next_billing_date,
    };
  });

  const steps: JourneyStep[] = [{
    key: "select_subscription",
    type: "single_choice",
    question: "Which subscription are you asking about?",
    options: options.map(s => ({
      value: s.id,
      label: s.items.map(i => `${i.quantity}x ${i.title}`).join(", ")
        + (s.nextBillingDate ? ` — next: ${new Date(s.nextBillingDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "")
        + (s.status !== "active" ? ` (${s.status})` : ""),
    })),
  }];

  return {
    codeDriven: true,
    multiStep: false,
    steps,
    metadata: {
      subscriptions: options,
      ticketId,
    },
  };
}
