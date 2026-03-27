/**
 * Address normalization for fraud detection.
 * Standardizes addresses so "123 Main St Apt 2" matches "123 main street #2".
 */

const STREET_ABBREVS: Record<string, string> = {
  street: "st",
  avenue: "ave",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  road: "rd",
  court: "ct",
  place: "pl",
  circle: "cir",
  terrace: "ter",
  trail: "trl",
  way: "way",
  highway: "hwy",
  parkway: "pkwy",
  expressway: "expy",
};

const UNIT_PATTERNS = [
  /\b(?:apt|apartment|unit|suite|ste|#|number|no|num)\s*[.:#-]?\s*/gi,
];

const DIRECTION_ABBREVS: Record<string, string> = {
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
};

export function normalizeAddress(address: {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
} | null): string | null {
  if (!address) return null;

  const parts = [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.zip,
    address.country,
  ]
    .filter(Boolean)
    .join(" ");

  if (!parts.trim()) return null;

  let normalized = parts.toLowerCase().trim();

  // Remove punctuation except # (temporarily keep for unit normalization)
  normalized = normalized.replace(/[.,'"]/g, "");

  // Normalize unit designators to a standard format
  for (const pattern of UNIT_PATTERNS) {
    normalized = normalized.replace(pattern, "unit ");
  }

  // Standardize street suffixes
  for (const [full, abbrev] of Object.entries(STREET_ABBREVS)) {
    const regex = new RegExp(`\\b${full}\\b`, "gi");
    normalized = normalized.replace(regex, abbrev);
  }

  // Standardize directions
  for (const [full, abbrev] of Object.entries(DIRECTION_ABBREVS)) {
    const regex = new RegExp(`\\b${full}\\b`, "gi");
    normalized = normalized.replace(regex, abbrev);
  }

  // Collapse multiple spaces
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized || null;
}

/**
 * Extract a normalized address from a Shopify order's shipping_address payload.
 */
export function normalizeShopifyShippingAddress(
  shippingAddress: Record<string, unknown> | null | undefined
): string | null {
  if (!shippingAddress) return null;

  return normalizeAddress({
    address1: shippingAddress.address1 as string | null,
    address2: shippingAddress.address2 as string | null,
    city: shippingAddress.city as string | null,
    province: shippingAddress.province as string | null,
    zip: shippingAddress.zip as string | null,
    country: shippingAddress.country as string | null,
  });
}
