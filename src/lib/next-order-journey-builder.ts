/**
 * Build next-order journey steps + metadata from a customer's live subscriptions.
 *
 * Code-driven journey: the mini-site renders an interactive subscription editor
 * (swap / quantity / add / remove / skip / change date / change frequency) plus
 * an in-journey cancel entry point, all driven off the metadata this builder
 * emits. Single source of truth for the next-order journey's steps + metadata —
 * mirrors src/lib/cancel-journey-builder.ts, and reuses the same select-subscription
 * step pattern so the token can carry an optional pre-selected subscription.
 *
 * Every edit the mini-site dispatches runs through the SAME shared executors the
 * portal uses (src/app/api/journey/[token]/edit → src/lib/subscription-items.ts +
 * src/lib/commerce/subscription.ts + src/lib/remedy-actions.ts). This module only
 * reads data; it never mutates.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { loadEditableCatalog } from "@/lib/portal/editable-catalog";
import { resolveSubscriptionPricing } from "@/lib/pricing";
import { priceSubscription } from "@/lib/commerce/price";

export interface NextOrderEditableItem {
  title: string;
  variant_title?: string;
  variant_id?: string;
  quantity: number;
  price?: string | null;
}

export interface NextOrderSubscription {
  id: string;
  contractId: string;
  items: NextOrderEditableItem[];
  nextBillingDate: string | null;
  totalPrice: string | null;
  frequency: string | null;
  billingInterval: string | null;
  billingIntervalCount: number | null;
  status: string;
  isFirstRenewal: boolean;
  subscriptionAgeDays: number;
}

export interface NextOrderCatalogVariant {
  variant_id: string;
  product_title: string;
  variant_title: string | null;
  price: string | null;
}

export interface NextOrderJourneyStep {
  key: string;
  type: "subscription_select" | "editor" | "info";
  question: string;
  subtitle?: string;
  options?: { value: string; label: string }[];
}

export interface NextOrderJourneyMetadata {
  customerId: string;
  workspaceId: string;
  ticketId: string;
  subscriptions: NextOrderSubscription[];
  catalog: NextOrderCatalogVariant[];
  cancelReasons: { value: string; label: string }[];
  selectedSubscriptionId?: string;
}

// Cancel reasons come from Settings → Cancel Flow (database only, no hardcoded
// defaults) — the same source the cancel journey reads, so an in-journey cancel
// shows the identical reason step before the shared save offers.
async function loadCancelReasons(admin: ReturnType<typeof createAdminClient>, workspaceId: string): Promise<{ value: string; label: string }[]> {
  const { data: ws } = await admin.from("workspaces").select("portal_config").eq("id", workspaceId).single();
  const portalConfig = (ws?.portal_config || {}) as Record<string, unknown>;
  const cancelConfig = (portalConfig.cancel_flow || {}) as Record<string, unknown>;
  const configuredReasons = Array.isArray(cancelConfig.reasons) ? cancelConfig.reasons : [];
  return configuredReasons
    .filter((r: { enabled?: boolean }) => r.enabled !== false)
    .sort((a: { sort_order?: number }, b: { sort_order?: number }) => (a.sort_order ?? 99) - (b.sort_order ?? 99))
    .map((r: { slug?: string; label?: string }) => ({ value: r.slug || "", label: r.label || "" }));
}

const SHIPPING_PROTECTION_KEYWORDS = ["shipping protection", "route", "shipping insurance", "insure"];

function isShippingProtection(title: string): boolean {
  const t = (title || "").toLowerCase();
  return SHIPPING_PROTECTION_KEYWORDS.some(kw => t.includes(kw));
}

export async function buildNextOrderJourneySteps(
  workspaceId: string,
  customerId: string,
  ticketId: string,
): Promise<{ steps: NextOrderJourneyStep[]; metadata: NextOrderJourneyMetadata }> {
  const admin = createAdminClient();

  // Resolve all linked customer ids so a subscription on a linked account is editable too.
  let allCustomerIds = [customerId];
  const { data: links } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId);
  if (links?.[0]?.group_id) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", links[0].group_id);
    allCustomerIds = (grp || []).map(m => m.customer_id);
  }

  // Active + paused subs: a paused sub still renews, so the next-order editor
  // should let the customer act on it (same inclusion the cancel builder uses).
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, items, next_billing_date, status, billing_interval, billing_interval_count, created_at, is_internal, comp, delivery_price_cents, pricing_offer_id, applied_discounts, shipping_protection_added, shipping_protection_amount_cents")
    .in("customer_id", allCustomerIds)
    .eq("workspace_id", workspaceId)
    .in("status", ["active", "paused"])
    .order("next_billing_date", { ascending: true });

  // Swap/add catalog comes from the SHARED Portal helper — same filtered list both
  // surfaces show (products_available_to_add, Shipping Protection excluded by id,
  // suppressed + out-of-stock + non-consumable variants dropped). The journey no
  // longer loads every `products` row (CEO parity rule, 2026-11-22).
  const editable = await loadEditableCatalog(workspaceId, admin);
  const cancelReasons = await loadCancelReasons(admin, workspaceId);

  const catalog: NextOrderCatalogVariant[] = [];
  for (const p of editable.products) {
    for (const v of p.variants) {
      catalog.push({
        variant_id: v.variantId,
        product_title: p.title,
        variant_title: v.title,
        // Reference list price; the EXACT swap/add price comes from the shared
        // price-quote path (src/app/api/journey/[token]/price-quote) on interaction.
        price: typeof v.priceCents === "number" ? `$${(v.priceCents / 100).toFixed(2)}` : null,
      });
    }
  }

  // Price each sub's lines + total through the ONE money resolver the Portal uses (priceSubscription,
  // src/lib/commerce/price.ts), so the journey total matches the Portal for EVERY engine. Internal
  // subs still resolve their per-line display via resolveSubscriptionPricing (exact, rule-aware);
  // non-internal (ShopCX/Appstle) lines carry `price_cents`, so priceSubscription sums them (the old
  // hand-sum of `items[].price` resolved ShopCX subs to no amount).
  const subscriptions: NextOrderSubscription[] = await Promise.all((subs || []).map(async sub => {
    const rawItems = (sub.items as { title: string; variant_title?: string; variant_id?: string; quantity?: number; price?: string | number; price_cents?: number }[] || []);
    const nonProtection = rawItems.filter(i => !isShippingProtection(i.title));

    let items: NextOrderEditableItem[];
    let total: number;

    if (sub.is_internal) {
      const pricing = await resolveSubscriptionPricing(workspaceId, {
        items: sub.items,
        delivery_price_cents: sub.delivery_price_cents,
        pricing_offer_id: sub.pricing_offer_id,
      });
      const productLines = pricing.lines.filter(l => l.kind === "product");
      items = productLines.map(l => ({
        title: l.title,
        variant_title: l.variant_title || undefined,
        variant_id: l.variant_id ? String(l.variant_id) : undefined,
        quantity: l.quantity,
        price: `$${(l.unit_cents / 100).toFixed(2)}`,
      }));
      total = (pricing.product_subtotal_cents + pricing.shipping_cents) / 100;
    } else {
      items = nonProtection.map(i => ({
        title: i.title,
        variant_title: i.variant_title,
        variant_id: i.variant_id ? String(i.variant_id) : undefined,
        quantity: i.quantity || 1,
        price: typeof i.price_cents === "number" ? `$${(i.price_cents / 100).toFixed(2)}` : (typeof i.price === "number" ? `$${i.price.toFixed(2)}` : (i.price ?? null)),
      }));
      // Total from the one money resolver (merch after discounts + shipping + protection), same as
      // the Portal. Fall back to the hand-sum only if a line can't be priced (PriceInvariantError).
      try {
        const { pricing } = await priceSubscription(workspaceId, sub as Record<string, unknown>);
        total = pricing.total_cents / 100;
      } catch {
        total = nonProtection.reduce((sum, i) => sum + ((typeof i.price_cents === "number" ? i.price_cents / 100 : parseFloat(String(i.price ?? "0"))) * (i.quantity || 1)), 0);
      }
    }

    const freq = sub.billing_interval && sub.billing_interval_count
      ? `Every ${sub.billing_interval_count} ${sub.billing_interval}${sub.billing_interval_count > 1 ? "s" : ""}`
      : null;

    const subAgeDays = sub.created_at
      ? Math.floor((Date.now() - new Date(sub.created_at).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    const billingIntervalDays = sub.billing_interval === "month"
      ? (sub.billing_interval_count || 1) * 30
      : sub.billing_interval === "week"
      ? (sub.billing_interval_count || 1) * 7
      : 30;
    const isFirstRenewal = subAgeDays < billingIntervalDays;

    return {
      id: sub.id,
      contractId: sub.shopify_contract_id,
      items,
      nextBillingDate: sub.next_billing_date,
      totalPrice: total > 0 ? `$${total.toFixed(2)}` : null,
      frequency: freq,
      billingInterval: sub.billing_interval,
      billingIntervalCount: sub.billing_interval_count,
      status: sub.status,
      isFirstRenewal,
      subscriptionAgeDays: subAgeDays,
    };
  }));

  const steps: NextOrderJourneyStep[] = [];

  // Select subscription when the customer has more than one (mirrors the
  // cancel builder's select-subscription step pattern). The mini-site skips
  // this when the token already carries a pre-selected subscription.
  if (subscriptions.length > 1) {
    steps.push({
      key: "select_subscription",
      type: "subscription_select",
      question: "Which subscription would you like to edit?",
      options: subscriptions.map(sub => {
        const names = sub.items.map(i => i.title).join(", ");
        const nextDate = sub.nextBillingDate
          ? new Date(sub.nextBillingDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "";
        return {
          value: sub.id,
          label: `${names}${nextDate ? ` — renews ${nextDate}` : ""}${sub.totalPrice ? ` — ${sub.totalPrice}` : ""}`,
        };
      }),
    });
  }

  // The editor itself is one interactive step rendered by the mini-site.
  steps.push({
    key: "editor",
    type: "editor",
    question: "Your next order",
    subtitle: "Make changes before your next delivery.",
  });

  return {
    steps,
    metadata: {
      customerId,
      workspaceId,
      ticketId,
      subscriptions,
      catalog,
      cancelReasons,
      selectedSubscriptionId: subscriptions.length === 1 ? subscriptions[0].id : undefined,
    },
  };
}
