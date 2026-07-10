/**
 * Shared current-address resolver for order-creating actions.
 *
 * Every action that ships something to a customer must resolve the
 * destination through this helper. Priority — the current canonical
 * address wins over a stale cited-order snapshot:
 *
 *   1. explicit `addressOverride` (an operator forcing a one-off destination)
 *   2. `customers.default_address` (canonical current address that
 *      `update_shipping_address` writes into on any address change)
 *   3. active subscription `shipping_address` (prefer `subscriptionId`
 *      when given; otherwise any subscription with an address)
 *   4. cited order's `shipping_address` (last-resort — the snapshot the
 *      customer had at the time of the cited order)
 *   5. most-recent order (deep safety net so we never end up with no
 *      address at all)
 *
 * Ticket 49ddd6c4 (Catherine Green — replacement shipped to stale
 * Rochester MN when both account default + subscription said Kirkland
 * WA) is the driving regression. The signal existed on
 * `customers.default_address` + the subscription; the executor read the
 * cited order first and ignored the current canonical address.
 *
 * The resolver ALSO returns a `diverged` flag when the cited order's
 * shipping address differs from the canonical current address it
 * chose — the caller records that as an internal note so the divergence
 * is never silent again.
 */

import type { createAdminClient } from "@/lib/supabase/admin";
import { normalizeCountryToIso2 } from "@/lib/country-iso2";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Raw shipping-address shape as it appears on any of our sources. Each
 * source encodes fields differently (Shopify uses `province`/`country`,
 * our own writes use `province_code`/`country_code`, camelCase leaks in
 * from Sonnet-passed overrides) — `normalizeAddress` collapses all of
 * them to the same normalized shape.
 */
export type RawShippingAddress = {
  first_name?: string | null;
  last_name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  province_code?: string | null;
  provinceCode?: string | null;
  state?: string | null;
  zip?: string | null;
  postal_code?: string | null;
  country?: string | null;
  country_code?: string | null;
  countryCode?: string | null;
} | Record<string, unknown> | null | undefined;

export interface NormalizedShippingAddress {
  firstName: string;
  lastName: string;
  phone: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  provinceCode: string;
  zip: string;
  countryCode: string;
}

export type AddressSource =
  | "override"
  | "default_address"
  | "subscription"
  | "cited_order"
  | "recent_order";

export interface ResolvedShippingAddress {
  address: NormalizedShippingAddress;
  source: AddressSource;
  /** Whether we saw a cited-order address that disagreed with the chosen one. */
  diverged: boolean;
  /** The cited-order snapshot (populated whenever an orderNumber was passed and a match was found). */
  citedOrderAddress: NormalizedShippingAddress | null;
}

export interface ResolverSources {
  addressOverride?: RawShippingAddress;
  defaultAddress?: RawShippingAddress;
  subscriptionAddress?: RawShippingAddress;
  citedOrderAddress?: RawShippingAddress;
  recentOrderAddress?: RawShippingAddress;
}

function s(v: unknown): string {
  if (v == null) return "";
  const str = String(v).trim();
  return str;
}

/** Coerce whatever shape a source gave us into our canonical camelCase shape. */
export function normalizeAddress(raw: RawShippingAddress): NormalizedShippingAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const address1 = s(a.address1);
  if (!address1) return null;
  const province = s(a.provinceCode) || s(a.province_code) || s(a.province) || s(a.state);
  const country = s(a.countryCode) || s(a.country_code) || s(a.country);
  return {
    firstName: s(a.firstName) || s(a.first_name),
    lastName: s(a.lastName) || s(a.last_name),
    phone: s(a.phone),
    address1,
    address2: s(a.address2),
    city: s(a.city),
    province: province,
    provinceCode: province.toUpperCase().slice(0, 2),
    zip: s(a.zip) || s(a.postal_code),
    // Route through normalizeCountryToIso2 so a full-name country like
    // "United States" resolves to "US" instead of being sliced to "UN"
    // (the SC132221 stall — the sliced "UN" propagates all the way to
    // the Shopify draft-order call and gets rejected there).
    countryCode: normalizeCountryToIso2(country),
  };
}

/**
 * Compare two normalized addresses semantically. Two addresses agree
 * when their normalized address1 + zip match case-insensitively. We
 * deliberately DON'T compare firstName/lastName (renames aren't moves)
 * or province (a fully-typed address1 already localizes the city).
 */
export function sameShippingAddress(a: NormalizedShippingAddress, b: NormalizedShippingAddress): boolean {
  const na = a.address1.trim().toLowerCase().replace(/\s+/g, " ");
  const nb = b.address1.trim().toLowerCase().replace(/\s+/g, " ");
  if (na !== nb) return false;
  const za = a.zip.trim().replace(/\s+/g, "").slice(0, 5).toLowerCase();
  const zb = b.zip.trim().replace(/\s+/g, "").slice(0, 5).toLowerCase();
  if (za && zb && za !== zb) return false;
  return true;
}

/**
 * Pure address-picker — no DB access. Given normalized inputs from each
 * source, apply the priority chain and detect divergence. Extracted so
 * the priority + divergence logic can be tested without a Supabase
 * mock.
 */
export function pickCanonicalShippingAddress(sources: ResolverSources): ResolvedShippingAddress | null {
  const override = normalizeAddress(sources.addressOverride);
  const defaultAddr = normalizeAddress(sources.defaultAddress);
  const subAddr = normalizeAddress(sources.subscriptionAddress);
  const citedAddr = normalizeAddress(sources.citedOrderAddress);
  const recentAddr = normalizeAddress(sources.recentOrderAddress);

  // Pick in priority order (spec: override → default_address → subscription → cited_order → recent_order).
  let chosen: NormalizedShippingAddress | null = null;
  let source: AddressSource | null = null;
  if (override) { chosen = override; source = "override"; }
  else if (defaultAddr) { chosen = defaultAddr; source = "default_address"; }
  else if (subAddr) { chosen = subAddr; source = "subscription"; }
  else if (citedAddr) { chosen = citedAddr; source = "cited_order"; }
  else if (recentAddr) { chosen = recentAddr; source = "recent_order"; }

  if (!chosen || !source) return null;

  // Divergence signal — the cited order says X, we chose Y from a
  // canonical current source (default_address / subscription). This is
  // exactly the 49ddd6c4 situation: silently shipping to the stale
  // snapshot is what the fix prevents; logging it so the operator can
  // see we noticed is the "signal the system had but ignored".
  //
  // We don't fire the signal when the operator explicitly overrode
  // (they already chose the destination) or when the cited order is
  // itself what we chose.
  const diverged =
    (source === "default_address" || source === "subscription") &&
    citedAddr != null &&
    !sameShippingAddress(chosen, citedAddr);

  return { address: chosen, source, diverged, citedOrderAddress: citedAddr };
}

export interface ResolveOptions {
  addressOverride?: RawShippingAddress;
  orderNumber?: string | null;
  subscriptionId?: string | null;
}

/**
 * Read the four candidate sources off Supabase and pick per
 * `pickCanonicalShippingAddress`. Returns `null` only when NO source
 * yielded an address (the caller must handle this — an order-creating
 * action with no destination fails loudly, not silently).
 */
export async function resolveCustomerShippingAddress(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  opts: ResolveOptions = {},
): Promise<ResolvedShippingAddress | null> {
  // Load the canonical current address off the customer profile — the
  // single field `update_shipping_address` writes into.
  const { data: cust } = await admin
    .from("customers")
    .select("default_address")
    .eq("workspace_id", workspaceId)
    .eq("id", customerId)
    .maybeSingle();
  const defaultAddress = (cust?.default_address as RawShippingAddress) ?? null;

  // Preferred subscription (if given) → otherwise any subscription
  // with an address, active preferred over paused/cancelled.
  let subscriptionAddress: RawShippingAddress = null;
  if (opts.subscriptionId) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("shipping_address")
      .eq("workspace_id", workspaceId)
      .eq("id", opts.subscriptionId)
      .maybeSingle();
    subscriptionAddress = (sub?.shipping_address as RawShippingAddress) ?? null;
  }
  if (!subscriptionAddress) {
    const { data: subs } = await admin
      .from("subscriptions")
      .select("shipping_address, status")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .order("status", { ascending: true })
      .limit(5);
    for (const row of subs || []) {
      const sa = row.shipping_address as RawShippingAddress;
      if (sa && typeof sa === "object" && (sa as Record<string, unknown>).address1) {
        subscriptionAddress = sa;
        break;
      }
    }
  }

  // Cited order — the source that used to win. Now the last-resort
  // fallback, and the source we compare against for the divergence
  // signal.
  let citedOrderAddress: RawShippingAddress = null;
  if (opts.orderNumber) {
    const { data: order } = await admin
      .from("orders")
      .select("shipping_address")
      .eq("workspace_id", workspaceId)
      .eq("order_number", opts.orderNumber)
      .maybeSingle();
    citedOrderAddress = (order?.shipping_address as RawShippingAddress) ?? null;
  }

  // Deep safety net — most recent order on file. Only ever wins when
  // every source above is empty (a customer with no default_address,
  // no subscription, no cited order).
  let recentOrderAddress: RawShippingAddress = null;
  const needsRecentFallback =
    !normalizeAddress(opts.addressOverride) &&
    !normalizeAddress(defaultAddress) &&
    !normalizeAddress(subscriptionAddress) &&
    !normalizeAddress(citedOrderAddress);
  if (needsRecentFallback) {
    const { data: orders } = await admin
      .from("orders")
      .select("shipping_address")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(5);
    for (const o of orders || []) {
      const oa = o.shipping_address as RawShippingAddress;
      if (oa && typeof oa === "object" && (oa as Record<string, unknown>).address1) {
        recentOrderAddress = oa;
        break;
      }
    }
  }

  return pickCanonicalShippingAddress({
    addressOverride: opts.addressOverride,
    defaultAddress,
    subscriptionAddress,
    citedOrderAddress,
    recentOrderAddress,
  });
}

/**
 * Human-readable divergence line for the internal system note — the
 * signal the executor ignored on ticket 49ddd6c4.
 */
export function formatDivergenceNote(resolved: ResolvedShippingAddress, orderNumber?: string | null): string {
  const from = resolved.citedOrderAddress;
  const to = resolved.address;
  const cited = orderNumber ? `order ${orderNumber}` : "the cited order";
  const fromLine = from ? `${from.address1}${from.city ? `, ${from.city}` : ""}${from.provinceCode ? ` ${from.provinceCode}` : ""}${from.zip ? ` ${from.zip}` : ""}` : "unknown";
  const toLine = `${to.address1}${to.city ? `, ${to.city}` : ""}${to.provinceCode ? ` ${to.provinceCode}` : ""}${to.zip ? ` ${to.zip}` : ""}`;
  const src = resolved.source === "default_address" ? "customer's current account address" : "customer's active subscription address";
  return `[Address divergence] ${cited} ships to ${fromLine}, but ${src} is ${toLine} — customer moved; shipping to current address.`;
}
