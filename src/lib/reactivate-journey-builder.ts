/**
 * reactivate-journey-builder — the one-click win-back journey.
 *
 * Built for the Mixed Berry crisis win-back (CEO 2026-07-30): 187 customers cancelled while Mixed
 * Berry was out of stock. It's back, and we want them to restart with ONE CLICK from an email —
 * no login, no reply-to-inbox, no human in the loop.
 *
 * WHY A JOURNEY AND NOT "REPLY TO THIS EMAIL"
 * A reply lands in the ticket queue and needs Sol or a human to read it, work out which subscription
 * the customer meant, and fire the action. Across 187 customers that is 187 interpretations and 187
 * chances to get it wrong. A journey session is bound to ONE customer and ONE subscription at mint
 * time, so the click is unambiguous and the mutation is deterministic.
 *
 * HOW THE NO-LOGIN LINK WORKS
 * `journey_sessions.token` is a 48-char URL-safe secret ([[journey-tokens]] `generateJourneyToken`)
 * minted per customer and resolved at `/journey/{token}`. The session already carries `customer_id`
 * + `subscription_id`, so the link IS the authentication — the customer never signs in. Tokens carry
 * `token_expires_at`; a win-back link is long-lived by design (the offer is the point) but still
 * bounded.
 *
 * SHAPE
 * Single terminal step, single choice. Restarting a subscription is not a decision that benefits
 * from a funnel — every extra screen is a place to lose them. The confirm IS the conversion.
 *
 * The chosen value is executed SYNCHRONOUSLY by [[winback-reactivate-choice]] (called from the
 * journey /complete and /step routes), and the customer sees the real result on the page:
 *   reactivate   → `reactivateSubscription` ([[subscription-reactivate]]), the same path as the
 *                  portal's Reactivate button: resume a paused sub, or revive a cancelled one on
 *                  ShopCX from our mirror at the customer's own price, first order tomorrow. A
 *                  missing card/address is reported honestly + noted on the ticket for follow-up.
 *   not_now      → recorded, no mutation — an honest opt-out beats a dead link
 *
 * 2026-11-21 fix: before this, the page posted outcome "completed" but the outcome handler only
 * acted on "reactivated" and keyed on a session.subscription_id the mint never set, so
 * "Yes, restart" never restarted anything.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { BuiltJourneyConfig } from "@/lib/journey-step-builder";

type Admin = ReturnType<typeof createAdminClient>;

function emptyConfig(): BuiltJourneyConfig {
  return { codeDriven: true, multiStep: false, steps: [] };
}

/** Shipping-protection lines (SKU "Insure01", title "Shipping Protection") are add-ons, not products. */
export function isProtectionLine(i: { sku?: unknown; title?: unknown }): boolean {
  return /^insure/i.test(String(i.sku ?? "")) || /shipping protection/i.test(String(i.title ?? ""));
}

/** True when a sub carries at least one real product (not only protection / $0 lines). */
export function hasRealItems(items: unknown): boolean {
  const list = (items as { sku?: string; title?: string; price_cents?: number }[] | null) || [];
  return list.some((i) => !isProtectionLine(i) && Number(i.price_cents ?? 1) !== 0);
}

/**
 * Resolve the subscription this win-back should restart.
 *
 * 1. The session's own `subscription_id` (the sub the email/SMS was minted for) wins, as long as it
 *    is still cancelled/paused and belongs to this customer's linked-account group. Without this the
 *    page could name and restart a DIFFERENT sub than the email (Dylan's 11/21 test: email said
 *    Creatine, page restarted a paused Shipping-Protection-only sub).
 * 2. Otherwise: a paused sub with real items, else the most recently updated cancelled sub with real
 *    items. A protection-only sub is never picked.
 *
 * Read across the whole linked-account group — a customer whose cancelled sub sits on a sibling
 * profile would otherwise get an empty journey.
 */
export async function resolveTargetSubscription(
  admin: Admin, workspaceId: string, customerId: string, preferredSubscriptionId?: string | null,
) {
  const { data: link } = await admin.from("customer_links")
    .select("group_id").eq("workspace_id", workspaceId).eq("customer_id", customerId).maybeSingle();
  let ids = [customerId];
  if (link?.group_id) {
    const { data: peers } = await admin.from("customer_links")
      .select("customer_id").eq("workspace_id", workspaceId).eq("group_id", link.group_id);
    ids = [...new Set([customerId, ...(peers || []).map((p) => p.customer_id as string)])];
  }
  const { data: subs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, status, items, updated_at")
    .eq("workspace_id", workspaceId).in("customer_id", ids)
    .in("status", ["cancelled", "paused"])
    .order("updated_at", { ascending: false });
  return pickTargetSubscription(subs || [], preferredSubscriptionId);
}

/** Pure selection rule behind `resolveTargetSubscription` (exported for tests). */
export function pickTargetSubscription<T extends { id: string; status: string; items: unknown }>(
  subs: T[], preferredSubscriptionId?: string | null,
): T | null {
  if (preferredSubscriptionId) {
    const bound = subs.find((s) => s.id === preferredSubscriptionId);
    if (bound) return bound;
  }
  const real = subs.filter((s) => hasRealItems(s.items));
  return real.find((s) => s.status === "paused") ?? real[0] ?? null;
}

export interface WinbackGift { variant_id: string; label: string }

/**
 * Free-gift options for the restart, DB-driven: `journey_definitions.config.winback_gifts` on the
 * workspace's win-back journey (seeded by migration 20270121120000). Each entry is a
 * product_variants UUID + the label the customer sees. Empty/absent → no gift, plain restart.
 * The click handler re-reads this list and only honours a variant that is on it.
 */
export async function loadWinbackGifts(admin: Admin, workspaceId: string): Promise<WinbackGift[]> {
  const { data } = await admin.from("journey_definitions")
    .select("config")
    .eq("workspace_id", workspaceId)
    .in("trigger_intent", ["reactivate_subscription", "reactivate", "win_back"])
    .eq("is_active", true)
    .order("priority", { ascending: false })
    .limit(1)
    .maybeSingle();
  const raw = ((data?.config as Record<string, unknown> | null)?.winback_gifts as unknown[]) || [];
  return raw
    .map((g) => g as Partial<WinbackGift>)
    .filter((g): g is WinbackGift => typeof g.variant_id === "string" && typeof g.label === "string" && !!g.variant_id && !!g.label);
}

/** Option value for "restart + this gift". Parsed back by `parseReactivateValue`. */
export function giftOptionValue(variantId: string): string {
  return `reactivate:${variantId}`;
}

/** `reactivate` → plain restart; `reactivate:<variant uuid>` → restart + that gift; else not a restart. */
export function parseReactivateValue(value: string): { restart: boolean; giftVariantId: string | null } {
  if (value === "reactivate") return { restart: true, giftVariantId: null };
  if (value.startsWith("reactivate:")) {
    const id = value.slice("reactivate:".length).trim();
    return { restart: true, giftVariantId: id || null };
  }
  return { restart: false, giftVariantId: null };
}

/** Human-readable item summary, e.g. "Superfood Tabs — Mixed Berry ×2". */
function describeItems(items: unknown): string {
  const list = (items as { title?: string; variant_title?: string; quantity?: number; sku?: string; price_cents?: number }[] | null) || [];
  const real = list.filter((i) => !isProtectionLine(i) && Number(i.price_cents ?? 1) !== 0);
  if (!real.length) return "your subscription";
  return real
    .map((i) => `${i.title ?? i.sku ?? "item"}${i.variant_title ? ` — ${i.variant_title}` : ""}${(i.quantity ?? 1) > 1 ? ` ×${i.quantity}` : ""}`)
    .join(", ");
}

export async function buildReactivateSteps(
  admin: Admin, workspaceId: string, customerId: string, ticketId: string,
  subscriptionId?: string | null,
): Promise<BuiltJourneyConfig> {
  const sub = await resolveTargetSubscription(admin, workspaceId, customerId, subscriptionId);
  if (!sub) return emptyConfig();

  const what = describeItems(sub.items);
  const wasPaused = sub.status === "paused";
  const gifts = await loadWinbackGifts(admin, workspaceId);
  const options = gifts.length
    ? [
        ...gifts.map((g) => ({ value: giftOptionValue(g.variant_id), label: `Restart + free ${g.label}` })),
        { value: "not_now", label: "Not right now" },
      ]
    : [
        { value: "reactivate", label: "Yes, restart my subscription" },
        { value: "not_now", label: "Not right now" },
      ];

  return {
    codeDriven: true,
    multiStep: false,
    steps: [{
      key: "reactivate_choice",
      type: "single_choice",
      question: wasPaused
        ? `Ready to restart your subscription? We'll pick it right back up with ${what}.`
        : `Want your subscription back? We'll restart it with ${what}.`,
      subtitle: gifts.length
        ? "Pick your free bag and you're set: same items, same price you had before, and the gift ships free in your first order, which processes tomorrow."
        : "One click and you're set: same items, same price you had before. Your next order processes tomorrow.",
      options,
      isTerminal: true,
    }],
    metadata: {
      journeyType: "reactivate_subscription",
      subscriptionId: sub.id,
      contractId: sub.shopify_contract_id,
      previousStatus: sub.status,
      customerId,
      workspaceId,
      ticketId,
    },
  };
}
