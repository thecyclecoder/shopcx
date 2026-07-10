// Country normalization for Shopify draft-order shipping addresses.
//
// Shopify's DraftOrderInput.shippingAddress.countryCode is ISO 3166-1 alpha-2
// ("US", "CA", "GB"). Draft-order creation fails when we hand it a full
// country name — this is what stranded the US replacement on ticket SC132896
// (country was "United States", not "US"). Normalize at the boundary.
//
// Also folds Shopify's US-territory convention: PR/GU/VI/AS/MP are shipped
// as country "US" with the territory expressed in the province code.

const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  "UNITED STATES": "US",
  "UNITED STATES OF AMERICA": "US",
  "USA": "US",
  "U.S.A.": "US",
  "U.S.": "US",
  "AMERICA": "US",
  "CANADA": "CA",
  "UNITED KINGDOM": "GB",
  "GREAT BRITAIN": "GB",
  "BRITAIN": "GB",
  "UK": "GB",
  "U.K.": "GB",
  "ENGLAND": "GB",
  "SCOTLAND": "GB",
  "WALES": "GB",
  "NORTHERN IRELAND": "GB",
  "AUSTRALIA": "AU",
  "NEW ZEALAND": "NZ",
  "IRELAND": "IE",
  "GERMANY": "DE",
  "FRANCE": "FR",
  "SPAIN": "ES",
  "ITALY": "IT",
  "PORTUGAL": "PT",
  "NETHERLANDS": "NL",
  "HOLLAND": "NL",
  "BELGIUM": "BE",
  "LUXEMBOURG": "LU",
  "SWITZERLAND": "CH",
  "AUSTRIA": "AT",
  "DENMARK": "DK",
  "NORWAY": "NO",
  "SWEDEN": "SE",
  "FINLAND": "FI",
  "ICELAND": "IS",
  "POLAND": "PL",
  "CZECH REPUBLIC": "CZ",
  "CZECHIA": "CZ",
  "SLOVAKIA": "SK",
  "HUNGARY": "HU",
  "ROMANIA": "RO",
  "BULGARIA": "BG",
  "GREECE": "GR",
  "TURKEY": "TR",
  "RUSSIA": "RU",
  "RUSSIAN FEDERATION": "RU",
  "UKRAINE": "UA",
  "ESTONIA": "EE",
  "LATVIA": "LV",
  "LITHUANIA": "LT",
  "SLOVENIA": "SI",
  "CROATIA": "HR",
  "SERBIA": "RS",
  "BOSNIA AND HERZEGOVINA": "BA",
  "ALBANIA": "AL",
  "MACEDONIA": "MK",
  "NORTH MACEDONIA": "MK",
  "MONTENEGRO": "ME",
  "CYPRUS": "CY",
  "MALTA": "MT",
  "MEXICO": "MX",
  "BRAZIL": "BR",
  "ARGENTINA": "AR",
  "CHILE": "CL",
  "COLOMBIA": "CO",
  "PERU": "PE",
  "VENEZUELA": "VE",
  "URUGUAY": "UY",
  "PARAGUAY": "PY",
  "ECUADOR": "EC",
  "BOLIVIA": "BO",
  "COSTA RICA": "CR",
  "PANAMA": "PA",
  "GUATEMALA": "GT",
  "HONDURAS": "HN",
  "EL SALVADOR": "SV",
  "NICARAGUA": "NI",
  "DOMINICAN REPUBLIC": "DO",
  "JAMAICA": "JM",
  "BAHAMAS": "BS",
  "BARBADOS": "BB",
  "TRINIDAD AND TOBAGO": "TT",
  "PUERTO RICO": "US",
  "GUAM": "US",
  "U.S. VIRGIN ISLANDS": "US",
  "VIRGIN ISLANDS": "US",
  "AMERICAN SAMOA": "US",
  "NORTHERN MARIANA ISLANDS": "US",
  "JAPAN": "JP",
  "CHINA": "CN",
  "HONG KONG": "HK",
  "TAIWAN": "TW",
  "SOUTH KOREA": "KR",
  "KOREA": "KR",
  "KOREA, REPUBLIC OF": "KR",
  "NORTH KOREA": "KP",
  "SINGAPORE": "SG",
  "MALAYSIA": "MY",
  "THAILAND": "TH",
  "VIETNAM": "VN",
  "PHILIPPINES": "PH",
  "INDONESIA": "ID",
  "INDIA": "IN",
  "PAKISTAN": "PK",
  "BANGLADESH": "BD",
  "SRI LANKA": "LK",
  "NEPAL": "NP",
  "MYANMAR": "MM",
  "CAMBODIA": "KH",
  "LAOS": "LA",
  "MONGOLIA": "MN",
  "KAZAKHSTAN": "KZ",
  "UZBEKISTAN": "UZ",
  "SAUDI ARABIA": "SA",
  "UNITED ARAB EMIRATES": "AE",
  "U.A.E.": "AE",
  "UAE": "AE",
  "ISRAEL": "IL",
  "PALESTINE": "PS",
  "JORDAN": "JO",
  "LEBANON": "LB",
  "SYRIA": "SY",
  "IRAQ": "IQ",
  "IRAN": "IR",
  "KUWAIT": "KW",
  "QATAR": "QA",
  "BAHRAIN": "BH",
  "OMAN": "OM",
  "YEMEN": "YE",
  "EGYPT": "EG",
  "MOROCCO": "MA",
  "ALGERIA": "DZ",
  "TUNISIA": "TN",
  "LIBYA": "LY",
  "SUDAN": "SD",
  "SOUTH AFRICA": "ZA",
  "NIGERIA": "NG",
  "KENYA": "KE",
  "ETHIOPIA": "ET",
  "GHANA": "GH",
  "TANZANIA": "TZ",
  "UGANDA": "UG",
  "ZIMBABWE": "ZW",
  "ZAMBIA": "ZM",
  "MOZAMBIQUE": "MZ",
  "ANGOLA": "AO",
  "SENEGAL": "SN",
  "IVORY COAST": "CI",
  "COTE D'IVOIRE": "CI",
  "CAMEROON": "CM",
  "MADAGASCAR": "MG",
  "MAURITIUS": "MU",
  "FIJI": "FJ",
  "PAPUA NEW GUINEA": "PG",
};

/** Known-good ISO 3166-1 alpha-2 codes. Derived from the reverse-name-map
 * values plus a hand-curated extension list so a 2-letter code like "UN"
 * (which is NOT a real ISO 3166-1 country code — it stranded Evan H.'s
 * SC132221 replacement) is rejected instead of trusted verbatim. Kept as a
 * conservative allowlist: adding a country is safer than trusting an
 * unknown code that Shopify will reject downstream. */
const KNOWN_ISO2_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(COUNTRY_NAME_TO_ISO2),
  // Common ISO-2 codes not otherwise present as a target in the reverse map.
  "AF", "AM", "AZ", "AW", "AX", "AZ", "BJ", "BF", "BI", "BW", "BY", "BZ",
  "CD", "CF", "CG", "CU", "CV", "DJ", "DM", "ER", "FO", "GA", "GD", "GE",
  "GI", "GL", "GM", "GN", "GQ", "GY", "HT", "KG", "KY", "LC", "LI", "LR",
  "LS", "MC", "MD", "MO", "MR", "MV", "MW", "NA", "NC", "NE", "PF", "PW",
  "RE", "RW", "SB", "SC", "SL", "SM", "SO", "SR", "ST", "SV", "SZ", "TD",
  "TG", "TJ", "TL", "TM", "TO", "TV", "VA", "VC", "VU", "WS",
]);

/** Strict normalizer — returns null when the input can't be resolved to a
 * KNOWN ISO 3166-1 alpha-2 code. This is what the guard-loud callers
 * (createReplacementOrder) use so a bogus code like "UN" surfaces as a
 * retryable failure instead of silently stalling at address_confirmed
 * (Evan H. SC132221, Jun-23 replacement that sat 17 days). */
export function normalizeCountryToIso2Strict(input: string | null | undefined): string | null {
  if (!input) return null;
  const upper = input.trim().toUpperCase();
  if (!upper) return null;

  // Shopify's US-territory convention — the territory codes ship as US.
  if (upper === "US" || upper === "PR" || upper === "GU" || upper === "VI" || upper === "AS" || upper === "MP") {
    return "US";
  }

  if (/^[A-Z]{2}$/.test(upper)) {
    return KNOWN_ISO2_CODES.has(upper) ? upper : null;
  }

  return COUNTRY_NAME_TO_ISO2[upper] || null;
}

/** Normalize a country identifier to Shopify's ISO 3166-1 alpha-2 country code.
 *
 * Accepts an ISO-2 code ("US"), a full name ("United States"), a common alias
 * ("USA", "UK"), or empty/missing input. Returns "US" as the fallback so the
 * caller always has a valid Shopify countryCode. Folds Shopify's US-territory
 * convention (PR/GU/VI/AS/MP → "US").
 *
 * Prefer this when the caller is happy defaulting to US on unresolvable
 * input (Superfoods is a US-first store); use
 * [[normalizeCountryToIso2Strict]] when the caller must fail loudly. */
export function normalizeCountryToIso2(input: string | null | undefined): string {
  return normalizeCountryToIso2Strict(input) || "US";
}
