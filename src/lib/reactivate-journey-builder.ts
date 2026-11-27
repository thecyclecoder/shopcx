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
 * 2026-11-22: a line under an ACTIVE crisis (out of stock) is named on the page ("X is out of stock
 * right now, so we'll send Y instead and switch you back as soon as it's restocked"), swapped on
 * restart and switched back on Resolve — see [[crisis-restart-swap]].
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
  const cfg = (data?.config as Record<string, unknown> | null) || {};
  // A limited-time gift offer stops on its stated deadline (config.winback_gifts_ends_at, ISO).
  // The email says "ends Dec 31", so the page must actually stop offering the gift then.
  if (!winbackGiftsLive(cfg.winback_gifts_ends_at)) return [];
  const raw = (cfg.winback_gifts as unknown[]) || [];
  return raw
    .map((g) => g as Partial<WinbackGift>)
    .filter((g): g is WinbackGift => typeof g.variant_id === "string" && typeof g.label === "string" && !!g.variant_id && !!g.label);
}

/** True while the gift offer is live: no deadline set, or the deadline is still in the future. */
export function winbackGiftsLive(endsAt: unknown, now: Date = new Date()): boolean {
  if (typeof endsAt !== "string" || !endsAt) return true;
  const t = Date.parse(endsAt);
  return Number.isNaN(t) ? true : now.getTime() < t;
}

/** Option value for "restart + this gift". Parsed back by `parseReactivateValue`. */
export function giftOptionValue(variantId: string): string {
  return `reactivate:${variantId}`;
}

/** Option value for "restart on the discontinued product's replacement". Parsed by `parseReactivateValue`. */
export const REACTIVATE_REPLACE_VALUE = "reactivate_replace";

/**
 * `reactivate` → plain restart; `reactivate_replace` → restart on the discontinued product's
 * replacement; `reactivate:<variant uuid>` → restart + that gift; else not a restart.
 */
export function parseReactivateValue(value: string): { restart: boolean; giftVariantId: string | null; replaceDiscontinued: boolean } {
  if (value === "reactivate") return { restart: true, giftVariantId: null, replaceDiscontinued: false };
  if (value === REACTIVATE_REPLACE_VALUE) return { restart: true, giftVariantId: null, replaceDiscontinued: true };
  if (value.startsWith("reactivate:")) {
    const id = value.slice("reactivate:".length).trim();
    return { restart: true, giftVariantId: id || null, replaceDiscontinued: false };
  }
  return { restart: false, giftVariantId: null, replaceDiscontinued: false };
}

/** `$29.95` from `2995`. The one place the restart price is rendered, so both surfaces match. */
export function formatReplacementPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface SubDiscontinuedReplacement {
  /** The configured replacement, or null when a discontinued-only sub has none configured. */
  replacement: import("@/lib/migrate-to-internal").DiscontinuedReplacement | null;
  /** Titles of the discontinued products on the sub (for the page copy + ticket note). */
  discontinuedTitles: string[];
}

/**
 * When EVERY real product line on a sub is a discontinued product, describe the replacement to
 * offer on restart (or `{ replacement: null }` when none is configured). Returns null when the sub
 * is NOT discontinued-only — the normal restart path applies. Resolves line → product via
 * `product_variants` (by Shopify id, then sku), then reads the configured replacement through the
 * [[migrate-to-internal]] reader. Shipping-protection / $0 lines are never counted.
 */
export async function subDiscontinuedReplacement(
  admin: Admin, workspaceId: string, items: unknown,
): Promise<SubDiscontinuedReplacement | null> {
  const list = (items as { sku?: string; title?: string; price_cents?: number; variant_id?: string | number }[] | null) || [];
  const real = list.filter((i) => !isProtectionLine(i) && Number(i.price_cents ?? 1) !== 0);
  if (!real.length) return null;

  const { data: variants } = await admin.from("product_variants")
    .select("product_id, sku, shopify_variant_id")
    .eq("workspace_id", workspaceId);
  const byShopify = new Map<string, string>();
  const bySku = new Map<string, string>();
  for (const v of (variants || []) as { product_id: string; sku: string | null; shopify_variant_id: string | null }[]) {
    if (v.shopify_variant_id) byShopify.set(String(v.shopify_variant_id), v.product_id);
    if (v.sku) bySku.set(String(v.sku).toLowerCase(), v.product_id);
  }
  const productIds = new Set<string>();
  for (const i of real) {
    const pid = byShopify.get(String(i.variant_id ?? "")) ?? bySku.get(String(i.sku ?? "").toLowerCase());
    if (pid) productIds.add(String(pid));
  }
  if (!productIds.size) return null;

  const { MIGRATION_EXCLUDED_PRODUCT_IDS, replacementForDiscontinued } = await import("@/lib/migrate-to-internal");
  // Only a sub whose EVERY real line is a discontinued product gets the replacement treatment.
  if (![...productIds].every((id) => MIGRATION_EXCLUDED_PRODUCT_IDS.has(id))) return null;

  const { data: dps } = await admin.from("products").select("title").in("id", [...productIds]);
  const discontinuedTitles = ((dps || []) as { title: string | null }[]).map((d) => String(d.title ?? "")).filter(Boolean);
  const replacement = await replacementForDiscontinued(admin, workspaceId, [...productIds]);
  return { replacement, discontinuedTitles };
}

/**
 * The result message BOTH surfaces render after a replacement restart succeeds — identical copy
 * (CLAUDE.md: mini-site and live chat produce identical ticket messages, only rendering differs).
 */
export function replacementResultMessage(replacementTitle: string, priceCents: number, when: string): string {
  return `Restarted with ${replacementTitle} at ${formatReplacementPrice(priceCents)}. Next order: ${when}.`;
}

/** The internal ticket note for a replacement restart, shared by both surfaces. */
export function replacementTicketNote(replacementTitle: string, discontinuedTitles: string[], priceCents: number): string {
  const disc = discontinuedTitles.join(", ") || "the discontinued product";
  return `[Win-back] Restarted with ${replacementTitle} in place of discontinued ${disc} at ${formatReplacementPrice(priceCents)}.`;
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

  // Discontinued-only sub: offer the configured replacement instead of a restart that would fail
  // `only_excluded_products`. When no replacement is configured, say plainly it is discontinued
  // (never the old "our team will reach out").
  const disc = await subDiscontinuedReplacement(admin, workspaceId, sub.items);
  if (disc) {
    const discName = disc.discontinuedTitles.join(", ") || "This product";
    if (disc.replacement) {
      const price = formatReplacementPrice(disc.replacement.priceCents);
      return {
        codeDriven: true,
        multiStep: false,
        steps: [{
          key: "reactivate_choice",
          type: "single_choice",
          question: `${discName} has been discontinued. Would you like to restart with ${disc.replacement.title} for ${price} instead?`,
          subtitle: `We'll restart your subscription with ${disc.replacement.title} at ${price} per order. Your next order processes tomorrow.`,
          options: [
            { value: REACTIVATE_REPLACE_VALUE, label: `Yes, restart with ${disc.replacement.title}` },
            { value: "not_now", label: "Not right now" },
          ],
          isTerminal: true,
        }],
        metadata: { journeyType: "reactivate_subscription", subscriptionId: sub.id, contractId: sub.shopify_contract_id, previousStatus: sub.status, customerId, workspaceId, ticketId },
      };
    }
    return {
      codeDriven: true,
      multiStep: false,
      steps: [{
        key: "reactivate_choice",
        type: "single_choice",
        question: `${discName} has been discontinued, so we can't restart this subscription as it was.`,
        subtitle: "We don't have a replacement to offer yet. You can keep your subscription off for now.",
        options: [{ value: "not_now", label: "Okay, keep it off" }],
        isTerminal: true,
      }],
      metadata: { journeyType: "reactivate_subscription", subscriptionId: sub.id, contractId: sub.shopify_contract_id, previousStatus: sub.status, customerId, workspaceId, ticketId },
    };
  }

  const gifts = await loadWinbackGifts(admin, workspaceId);
  // Out-of-stock flavors (active crisis) are swapped on restart; say so BEFORE they click.
  const { crisisSwapsForItems, crisisNotice } = await import("@/lib/crisis-restart-swap");
  const notice = crisisNotice(await crisisSwapsForItems(admin, workspaceId, sub.items, sub.id));
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
      subtitle: (gifts.length
        ? "Pick your free bag and you're set: same items, same price you had before, and the gift ships free in your first order, which processes tomorrow."
        : "One click and you're set: same items, same price you had before. Your next order processes tomorrow.")
        + (notice ? ` ${notice}` : ""),
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
