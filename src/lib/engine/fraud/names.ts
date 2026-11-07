/**
 * Name normalizers shared by the fraud signals — moved from fraud-detector.ts
 * (engine Phase 1).
 */

/** Two names overlap if one's first-name token contains the other's (≥4 chars),
 *  catching padding like "stephen" → "benstephen"/"estephen". */
export function firstNameOverlap(a: string, b: string): boolean {
  return !!a && !!b && (a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b)));
}

export function normalizeNameTokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ") // drop punctuation + apostrophes
    .split(/\s+/)
    .filter(Boolean);
}

// First + last token agree (case, punctuation, apostrophes, middle names ignored).
// Missing data on either side is NOT treated as a mismatch.
export function cardBillingNamesAgree(cardName: string, billingName: string): boolean {
  const a = normalizeNameTokens(cardName);
  const b = normalizeNameTokens(billingName);
  if (!a.length || !b.length) return true;
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}

export function surnameOf(cardName: string): string {
  const t = normalizeNameTokens(cardName);
  return t.length ? t[t.length - 1] : "";
}

// Shopify returns single-letter AVS/CVV codes; 'N' = no match / failure. Only an
// explicit 'N' counts so unknown/unsupported codes never false-positive.
export function isAvsOrCvvFailure(avs: string, cvv: string): boolean {
  return avs.trim().toUpperCase() === "N" || cvv.trim().toUpperCase() === "N";
}
