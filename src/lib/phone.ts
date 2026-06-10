/**
 * Phone helpers. Canonical home for E.164 normalization.
 *
 * WHY THIS EXISTS: customer phone numbers are stored in whatever shape they
 * arrived (Shopify import, manual entry, checkout) — often display-formatted
 * like "(858) 334-9198". Every Twilio endpoint (Messages, Verify, Lookup)
 * requires E.164 ("+18583349198") and silently rejects anything else. Rather
 * than backfill the whole customers table, we normalize at the boundary: the
 * low-level Twilio wrappers (sendSMS, startVerification, checkVerification,
 * lookupPhone) run `normalizePhoneForTwilio` on the destination so EVERY
 * caller is covered automatically. Don't call Twilio with a raw phone — go
 * through the wrappers.
 */

/**
 * Normalize a US phone to E.164. Returns null when the digits don't add up to
 * a valid US number (10 digits, or 11 with a leading 1), so callers can treat
 * that as an input error.
 *
 *   "(858) 334-9198" → "+18583349198"
 *   "8583349198"     → "+18583349198"
 *   "18583349198"    → "+18583349198"
 *   "+18583349198"   → "+18583349198"
 */
export function toE164US(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

/**
 * Normalize a Twilio destination right before an API call. Emails (Verify's
 * email channel) and empty values pass through untouched; phones become E.164
 * when parseable, else pass through unchanged (Twilio rejects bad ones exactly
 * as before — we never make a previously-working call worse).
 */
export function normalizePhoneForTwilio(value: string | null | undefined): string {
  const v = (value || "").trim();
  if (!v || v.includes("@")) return v; // email (Verify email channel) or empty — leave alone
  return toE164US(v) || v;
}
