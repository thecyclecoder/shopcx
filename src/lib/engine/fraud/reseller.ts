/**
 * Known-reseller address matching — COPIED (engine Phase 1) from
 * src/lib/known-resellers.ts (`normalizeReseller`, `parseAddressLines`) and
 * `haikuAddressesMatch` / `checkAmazonResellerMatch` in
 * src/lib/fraud-detector.ts. Legacy stays the parity oracle.
 *
 * Two-pass match, same as legacy:
 *   1. Fast path: equality on `normalizeReseller` form ("10083 Lynden Oval,
 *      44130" and "10083 lynden ovl|44130" are the same after normalize).
 *   2. Slow path: same 5-digit zip AND same leading street number (leading
 *      zeros ignored) → ask a fast model whether both strings are the same
 *      physical mailbox (catches "010083 Lynden Ova.l, Apt1").
 *
 * No network: the caller injects `llm(prompt) => Promise<string>` (its own
 * client, key and model; legacy uses Haiku with max_tokens 5). The engine owns
 * only the prompt and the MATCH/DIFFERENT parse. An `llm` that throws counts as
 * DIFFERENT, matching legacy's catch → false (legacy also returns false when
 * the API key is missing or the HTTP response is not ok).
 *
 * Doc drift (plan §5 item 3): the fraud-detection lifecycle page says the model
 * returns `{ match, confidence }` with a 0.8 threshold; the code asks for one
 * word and treats any answer starting with "MATCH" (case-insensitive) as a match.
 */

// ── Normalizers (copied from src/lib/known-resellers.ts) ──

export interface ParsedAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
}

/**
 * Parse an Amazon storefront "Business Address" block (one line per entry),
 * working backwards: country, zip, state, city, then street line(s).
 */
export function parseAddressLines(lines: string[]): ParsedAddress {
  const trimmed = lines.map(l => l.trim()).filter(Boolean);
  const result: ParsedAddress = { address1: null, address2: null, city: null, state: null, zip: null, country: "US" };
  if (!trimmed.length) return result;

  const working = [...trimmed];
  // Country
  if (/^US$|United States/i.test(working[working.length - 1])) {
    result.country = "US";
    working.pop();
  } else if (working.length > 0 && /^[A-Z]{2}$/.test(working[working.length - 1])) {
    result.country = working[working.length - 1];
    working.pop();
  }
  // Zip
  if (working.length > 0 && /\b\d{5}(-\d{4})?\b/.test(working[working.length - 1])) {
    result.zip = working[working.length - 1].match(/\b\d{5}(-\d{4})?\b/)![0];
    working.pop();
  }
  // State (full name or 2-letter)
  if (working.length > 0) {
    result.state = working[working.length - 1];
    working.pop();
  }
  // City
  if (working.length > 0) {
    result.city = working[working.length - 1];
    working.pop();
  }
  // Street: rest
  result.address1 = working[0] || null;
  result.address2 = working.length > 1 ? working.slice(1).join(", ") : null;
  return result;
}

/**
 * Normalize an address for exact-equality matching (`street|zip5`). Strips the
 * common reseller obfuscations: extra dots, leading zeros, "Street" vs "St".
 */
export function normalizeReseller(addr: { address1?: string | null; zip?: string | null }): string {
  const street = (addr.address1 || "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/^0+/, "")          // "010083" → "10083"
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\bsuite\b/g, "ste")
    .replace(/\bapartment\b/g, "apt")
    .replace(/\boval\b/g, "ovl")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const zip = (addr.zip || "").slice(0, 5);
  return `${street}|${zip}`;
}

// ── Address-match prompt + parser (copied from haikuAddressesMatch) ──

export interface AddressLite {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  province?: string | null;
  province_code?: string | null;
  zip?: string | null;
}

/** One-line rendering used inside the prompt. */
export function formatAddressForMatch(x: AddressLite): string {
  return [x.address1, x.address2, x.city, x.state || x.province, x.zip].filter(Boolean).join(", ");
}

/** Prompt legacy sends to Haiku. Must stay byte-identical (Phase 2 asserts it). */
export function buildAddressMatchPrompt(a: AddressLite, b: AddressLite): string {
  const fmt = formatAddressForMatch;
  const prompt = `You are detecting whether two addresses point to the same physical mailbox. Resellers deliberately mangle their address to evade filters — your job is to see through the obfuscation.

Address A (incoming order): ${fmt(a)}
Address B (known reseller):  ${fmt(b)}

Reply EXACTLY one word: "MATCH" or "DIFFERENT".

These count as MATCH (same physical location):
- Different formatting: "St" vs "Street", "Ave" vs "Avenue", "Apt 1" vs "Unit 1"
- Extra leading zeros on the street number: "010083" vs "10083"
- Punctuation injected mid-word: "Ova.l" vs "Oval", "Roma.ine" vs "Romaine"
- Missing or extra street type: "7704 Romaine" vs "7704 Romaine St"
- Random trailing tokens: "7040 N Olin Ave ave44" vs "7040 N Olin Ave"
- Different unit/apt numbers within the same building (still same building)
- Capitalization, extra spaces, comma vs no-comma

These count as DIFFERENT:
- Different street number (after removing leading zeros)
- Different zip code
- Different street name (when not just a typo/obfuscation of the same name)`;
  return prompt;
}

/** Legacy parse: trim, uppercase, starts with "MATCH". Anything else is DIFFERENT. */
export function parseAddressMatchAnswer(text: string | null | undefined): boolean {
  const ans = (text || "").trim().toUpperCase();
  return ans.startsWith("MATCH");
}

/** Token budget legacy gives the address-match call. */
export const ADDRESS_MATCH_MAX_TOKENS = 5;

export type ResellerLlm = (prompt: string) => Promise<string>;

/** Ask the injected model; any thrown error counts as DIFFERENT (legacy catch → false). */
export async function addressesMatch(a: AddressLite, b: AddressLite, llm: ResellerLlm): Promise<boolean> {
  try {
    return parseAddressMatchAnswer(await llm(buildAddressMatchPrompt(a, b)));
  } catch {
    return false;
  }
}

// ── Prefilter + matcher (copied from checkAmazonResellerMatch) ──

export interface KnownReseller {
  id: string;
  business_name: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  normalized_address: string | null;
  amazon_seller_id: string | null;
}

export type ResellerSide = "shipping" | "billing";

/**
 * What legacy does with one (order address, reseller) pair:
 *  - "exact": stored `normalized_address` equals the order's `normalizeReseller` form
 *  - "ask":   same zip5 and same leading street number (leading zeros dropped) → ask the model
 *  - "skip":  neither
 */
export function classifyResellerCandidate(addr: AddressLite, reseller: KnownReseller): "exact" | "ask" | "skip" {
  const orderNorm = normalizeReseller({ address1: addr.address1, zip: addr.zip });
  if (reseller.normalized_address && reseller.normalized_address === orderNorm) return "exact";
  const orderZip = (addr.zip || "").slice(0, 5);
  const resellerZip = (reseller.zip || "").slice(0, 5);
  if (!orderZip || orderZip !== resellerZip) return "skip";
  const orderNum = (addr.address1 || "").match(/\d+/)?.[0] || "";
  const resellerNum = (reseller.address1 || "").match(/\d+/)?.[0] || "";
  if (!orderNum || orderNum.replace(/^0+/, "") !== resellerNum.replace(/^0+/, "")) return "skip";
  return "ask";
}

/** The order's address sides in legacy order: shipping first, then billing. */
export function orderAddressSides(order: { shipping_address: unknown; billing_address: unknown }): Array<{ side: ResellerSide; addr: AddressLite }> {
  const ship = (order.shipping_address as AddressLite | null) || null;
  const bill = (order.billing_address as AddressLite | null) || null;
  const out: Array<{ side: ResellerSide; addr: AddressLite }> = [];
  if (ship) out.push({ side: "shipping", addr: ship });
  if (bill) out.push({ side: "billing", addr: bill });
  return out;
}

export interface ResellerCandidatePrefilter {
  exact: Array<{ reseller: KnownReseller; side: ResellerSide }>;
  ask: Array<{ reseller: KnownReseller; side: ResellerSide; addr: AddressLite }>;
}

/** Sync prefilter: exact hits plus the pairs worth one model call each. */
export function prefilterResellerCandidates(
  order: { shipping_address: unknown; billing_address: unknown },
  resellers: KnownReseller[],
): ResellerCandidatePrefilter {
  const out: ResellerCandidatePrefilter = { exact: [], ask: [] };
  for (const { side, addr } of orderAddressSides(order)) {
    for (const r of resellers) {
      const c = classifyResellerCandidate(addr, r);
      if (c === "exact") out.exact.push({ reseller: r, side });
      else if (c === "ask") out.ask.push({ reseller: r, side, addr });
    }
  }
  return out;
}

export interface ResellerHit {
  reseller: KnownReseller;
  matchedOn: ResellerSide;
  method: "exact" | "haiku";
}

/**
 * Full match, in legacy order (shipping then billing, resellers in input order,
 * model calls made sequentially). Returns hits deduped by reseller id (first
 * wins — the same reseller may match on both sides); `hits[0]` is legacy's
 * "primary" used for the case title and action log.
 */
export async function matchKnownResellers(
  order: { shipping_address: unknown; billing_address: unknown },
  resellers: KnownReseller[],
  llm: ResellerLlm,
): Promise<ResellerHit[]> {
  if (!resellers.length) return [];
  const hits: ResellerHit[] = [];
  for (const { side, addr } of orderAddressSides(order)) {
    for (const r of resellers) {
      const c = classifyResellerCandidate(addr, r);
      if (c === "exact") {
        hits.push({ reseller: r, matchedOn: side, method: "exact" });
        continue;
      }
      if (c === "skip") continue;
      const matched = await addressesMatch(addr, {
        address1: r.address1, address2: r.address2, city: r.city, state: r.state, zip: r.zip,
      }, llm);
      if (matched) hits.push({ reseller: r, matchedOn: side, method: "haiku" });
    }
  }
  const unique = new Map<string, ResellerHit>();
  for (const h of hits) if (!unique.has(h.reseller.id)) unique.set(h.reseller.id, h);
  return [...unique.values()];
}

/** Legacy case title for a reseller match. */
export function resellerCaseTitle(primary: ResellerHit, orderNumber: string | null | undefined, shopifyOrderId: string): string {
  return `Amazon reseller address match: ${primary.reseller.business_name || primary.reseller.amazon_seller_id} on order ${orderNumber || shopifyOrderId}`;
}
