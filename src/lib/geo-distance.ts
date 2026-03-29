// Geo-distance calculation using US zip code centroids + Haversine formula
// Uses the `zipcodes` npm package for lat/lng lookups (~42K US zip codes)

import zipcodes from "zipcodes";

const EARTH_RADIUS_MILES = 3958.8;

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Haversine distance between two lat/lng points in miles
 */
export function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

/**
 * Look up lat/lng for a US zip code. Returns null if not found.
 */
export function zipToLatLng(zip: string): { lat: number; lng: number } | null {
  // Normalize to 5-digit zip
  const cleaned = zip.replace(/\D/g, "").slice(0, 5);
  if (cleaned.length !== 5) return null;

  const result = zipcodes.lookup(cleaned);
  if (!result) return null;

  return { lat: result.latitude, lng: result.longitude };
}

/**
 * Calculate distance in miles between two US zip codes.
 * Returns null if either zip code is invalid.
 */
export function zipDistance(zip1: string, zip2: string): number | null {
  const loc1 = zipToLatLng(zip1);
  const loc2 = zipToLatLng(zip2);
  if (!loc1 || !loc2) return null;
  return haversineDistance(loc1.lat, loc1.lng, loc2.lat, loc2.lng);
}

/**
 * Extract zip code from an address object.
 * Handles Shopify address format: { zip: "90210", ... }
 */
export function extractZip(address: { zip?: string; postal_code?: string } | null): string | null {
  if (!address) return null;
  const raw = address.zip || address.postal_code || "";
  const cleaned = raw.replace(/\D/g, "").slice(0, 5);
  return cleaned.length === 5 ? cleaned : null;
}
