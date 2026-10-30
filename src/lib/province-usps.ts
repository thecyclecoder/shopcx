// Province/state normalization for shipping addresses.
//
// Shopify's shippingAddress.provinceCode is the USPS/ISO 3166-2 subdivision
// code ("NV", "CA", "ON"). When a stored province is a FULL NAME, the old
// `province.toUpperCase().slice(0,2)` derivation produced valid-but-WRONG
// codes on prefix collisions — "Nevada" → "NE" (Nebraska), "Montana" → "MO"
// (Missouri), "Alaska" → "AL" (Alabama). A wrong-but-valid code fails
// Shopify delivery-method zip validation ("Delivery method shipping address
// zip is invalid"), which wedged Chanen Cross's portal reactivate (contract
// 28153413805, ticket 84a8104a) until a human re-wrote the province as NV.
//
// This mirrors src/lib/country-iso2.ts `normalizeCountryToIso2`: map full
// names to codes, pass through already-valid 2-letter codes, and — critically
// — leave an unknown / non-US value UNSLICED rather than emitting a wrong
// 2-char guess.

const US_STATE_NAME_TO_CODE: Record<string, string> = {
  "ALABAMA": "AL",
  "ALASKA": "AK",
  "ARIZONA": "AZ",
  "ARKANSAS": "AR",
  "CALIFORNIA": "CA",
  "COLORADO": "CO",
  "CONNECTICUT": "CT",
  "DELAWARE": "DE",
  "DISTRICT OF COLUMBIA": "DC",
  "WASHINGTON DC": "DC",
  "WASHINGTON D.C.": "DC",
  "FLORIDA": "FL",
  "GEORGIA": "GA",
  "HAWAII": "HI",
  "IDAHO": "ID",
  "ILLINOIS": "IL",
  "INDIANA": "IN",
  "IOWA": "IA",
  "KANSAS": "KS",
  "KENTUCKY": "KY",
  "LOUISIANA": "LA",
  "MAINE": "ME",
  "MARYLAND": "MD",
  "MASSACHUSETTS": "MA",
  "MICHIGAN": "MI",
  "MINNESOTA": "MN",
  "MISSISSIPPI": "MS",
  "MISSOURI": "MO",
  "MONTANA": "MT",
  "NEBRASKA": "NE",
  "NEVADA": "NV",
  "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM",
  "NEW YORK": "NY",
  "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND",
  "OHIO": "OH",
  "OKLAHOMA": "OK",
  "OREGON": "OR",
  "PENNSYLVANIA": "PA",
  "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD",
  "TENNESSEE": "TN",
  "TEXAS": "TX",
  "UTAH": "UT",
  "VERMONT": "VT",
  "VIRGINIA": "VA",
  "WASHINGTON": "WA",
  "WEST VIRGINIA": "WV",
  "WISCONSIN": "WI",
  "WYOMING": "WY",
  // US territories Shopify ships as country "US" with the territory in the
  // province code (mirrors country-iso2.ts territory folding).
  "PUERTO RICO": "PR",
  "GUAM": "GU",
  "U.S. VIRGIN ISLANDS": "VI",
  "US VIRGIN ISLANDS": "VI",
  "VIRGIN ISLANDS": "VI",
  "AMERICAN SAMOA": "AS",
  "NORTHERN MARIANA ISLANDS": "MP",
  "ARMED FORCES AMERICAS": "AA",
  "ARMED FORCES EUROPE": "AE",
  "ARMED FORCES PACIFIC": "AP",
};

const CA_PROVINCE_NAME_TO_CODE: Record<string, string> = {
  "ALBERTA": "AB",
  "BRITISH COLUMBIA": "BC",
  "MANITOBA": "MB",
  "NEW BRUNSWICK": "NB",
  "NEWFOUNDLAND AND LABRADOR": "NL",
  "NEWFOUNDLAND": "NL",
  "NORTHWEST TERRITORIES": "NT",
  "NOVA SCOTIA": "NS",
  "NUNAVUT": "NU",
  "ONTARIO": "ON",
  "PRINCE EDWARD ISLAND": "PE",
  "QUEBEC": "QC",
  "QUÉBEC": "QC",
  "SASKATCHEWAN": "SK",
  "YUKON": "YT",
  "YUKON TERRITORY": "YT",
};

const NAME_TO_CODE: Record<string, string> = {
  ...US_STATE_NAME_TO_CODE,
  ...CA_PROVINCE_NAME_TO_CODE,
};

/** Known-good 2-letter subdivision codes (US states + territories + CA
 * provinces). Used to recognize an already-valid code so it passes through
 * verbatim instead of being re-mapped. */
const KNOWN_CODES: ReadonlySet<string> = new Set<string>(Object.values(NAME_TO_CODE));

/**
 * Normalize a state/province identifier to its 2-letter USPS/ISO 3166-2 code.
 *
 * - Full US state name ("Nevada") → correct code ("NV"), NEVER a sliced
 *   prefix collision ("NE").
 * - Full Canadian province name ("Ontario") → code ("ON").
 * - Already-valid 2-letter code ("WA", "ca") → passed through uppercased.
 * - Unknown / non-US-CA value (a foreign subdivision like "Bavaria") → the
 *   trimmed input is returned UNSLICED, so we never emit a wrong 2-char guess
 *   that Shopify would accept-but-misroute. Empty/missing input → "".
 */
export function normalizeProvinceToCode(input: string | null | undefined): string {
  if (!input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  const upper = trimmed.toUpperCase();

  // Already a valid 2-letter code — pass through uppercased.
  if (/^[A-Z]{2}$/.test(upper) && KNOWN_CODES.has(upper)) return upper;

  // Full name → code.
  const mapped = NAME_TO_CODE[upper];
  if (mapped) return mapped;

  // An unrecognized 2-letter token is already code-shaped; uppercase it
  // rather than treating it as a full name.
  if (/^[A-Z]{2}$/.test(upper)) return upper;

  // Unknown / non-US-CA full value — leave it unsliced. Emitting a 2-char
  // guess here is exactly the ticket-84a8104a defect.
  return trimmed;
}
