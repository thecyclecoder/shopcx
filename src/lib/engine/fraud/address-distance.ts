/**
 * Address-distance signal (billing zip far from shipping zip) — COPIED (engine
 * Phase 1) from `checkAddressDistance` in src/lib/fraud-detector.ts, plus the
 * zip helpers from src/lib/geo-distance.ts. Legacy stays the parity oracle.
 *
 * Pure: takes the order + rule config, returns the finding (title + evidence
 * exactly as legacy writes them to `fraud_cases`) or null. Dedupe against
 * existing cases, case insert, and the `fraud/case.created` event stay in the
 * caller's wiring.
 */
import zipcodes from "zipcodes";

// ── Zip geo helpers (copied from src/lib/geo-distance.ts) ──

const EARTH_RADIUS_MILES = 3958.8;

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/** Haversine distance between two lat/lng points in miles. */
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

/** Look up lat/lng for a US zip code (5-digit, non-digits stripped). Null if unknown. */
export function zipToLatLng(zip: string): { lat: number; lng: number } | null {
  const cleaned = zip.replace(/\D/g, "").slice(0, 5);
  if (cleaned.length !== 5) return null;
  const result = zipcodes.lookup(cleaned);
  if (!result) return null;
  return { lat: result.latitude, lng: result.longitude };
}

/** Distance in miles between two US zip codes; null if either is invalid. */
export function zipDistance(zip1: string, zip2: string): number | null {
  const loc1 = zipToLatLng(zip1);
  const loc2 = zipToLatLng(zip2);
  if (!loc1 || !loc2) return null;
  return haversineDistance(loc1.lat, loc1.lng, loc2.lat, loc2.lng);
}

/** 5-digit zip from a Shopify address object (`zip`, else `postal_code`). */
export function extractZip(address: { zip?: string; postal_code?: string } | null): string | null {
  if (!address) return null;
  const raw = address.zip || address.postal_code || "";
  const cleaned = raw.replace(/\D/g, "").slice(0, 5);
  return cleaned.length === 5 ? cleaned : null;
}

// ── Evaluator ──

export interface AddressDistanceConfig {
  distance_threshold_miles?: number | null;
}

export const DEFAULT_DISTANCE_THRESHOLD_MILES = 100;

export interface AddressDistanceOrder {
  shopify_order_id: string;
  billing_address: unknown;
  shipping_address: unknown;
}

export interface AddressDistanceEvidence {
  billing_zip: string;
  shipping_zip: string;
  billing_address: string;
  shipping_address: string;
  distance_miles: number;
  threshold_miles: number;
  order_id: string;
}

export interface AddressDistanceFinding {
  /** Unrounded haversine distance. */
  distanceMiles: number;
  title: string;
  evidence: AddressDistanceEvidence;
  /** Legacy dedupes on rule + `evidence->>order_id` among non-closed cases. */
  dedupeKey: string;
}

type ZipAddress = { zip?: string; first_name?: string; last_name?: string; city?: string; province?: string };

/**
 * Fires when billing and shipping zips are both valid, differ, resolve to known
 * US zips, and sit at least `distance_threshold_miles` (default 100) apart.
 * A distance exactly equal to the threshold fires (legacy uses `< threshold`
 * to skip). Only `zip` / `city` / `province` are read, which are the same keys
 * in Shopify's camelCase and snake_case address shapes, so this signal is not
 * affected by the camelCase billing quirk (see name-mismatch.ts).
 */
export function evaluateAddressDistance(
  order: AddressDistanceOrder,
  config: AddressDistanceConfig | null | undefined,
): AddressDistanceFinding | null {
  const threshold = config?.distance_threshold_miles || DEFAULT_DISTANCE_THRESHOLD_MILES;

  const billing = order.billing_address as ZipAddress | null;
  const shipping = order.shipping_address as ZipAddress | null;

  const billingZip = extractZip(billing);
  const shippingZip = extractZip(shipping);

  if (!billingZip || !shippingZip) return null;
  if (billingZip === shippingZip) return null;

  const distance = zipDistance(billingZip, shippingZip);
  if (distance === null || distance < threshold) return null;

  const evidence: AddressDistanceEvidence = {
    billing_zip: billingZip,
    shipping_zip: shippingZip,
    billing_address: billing ? `${billing.city || ""}, ${billing.province || ""}`.trim() : billingZip,
    shipping_address: shipping ? `${shipping.city || ""}, ${shipping.province || ""}`.trim() : shippingZip,
    distance_miles: Math.round(distance),
    threshold_miles: threshold,
    order_id: order.shopify_order_id,
  };

  return {
    distanceMiles: distance,
    title: `Billing/shipping ${Math.round(distance)} miles apart on order #${order.shopify_order_id}`,
    evidence,
    dedupeKey: `order:${order.shopify_order_id}:address_distance`,
  };
}
