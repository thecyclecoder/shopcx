/**
 * Twilio Lookup — line-type intelligence (storefront-mvp Phase 4e).
 *
 * The popup gates phone capture: the discount coupon is delivered by SMS
 * and auto-applied, so the number MUST be a real SMS-capable mobile — no
 * fake numbers get the discount and the SMS marketing list stays clean.
 * We block landline + VoIP (mobile-only is the stricter, cleaner choice
 * — see the spec's resolved open question).
 *
 * Uses the global Twilio account creds (same as sendSMS). Best-effort:
 * on any API error we FAIL CLOSED (treat as not-verified) so a Lookup
 * outage can't leak the discount to unverified numbers.
 */
const LOOKUP_BASE = "https://lookups.twilio.com/v2/PhoneNumbers";

export interface PhoneLookupResult {
  valid: boolean;
  mobile: boolean;
  e164: string | null;
  carrier: string | null;
  lineType: string | null;
  reason?: string;
}

export async function lookupPhone(phone: string): Promise<PhoneLookupResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return { valid: false, mobile: false, e164: null, carrier: null, lineType: null, reason: "twilio_not_configured" };
  }

  const cleaned = phone.trim();
  const url = `${LOOKUP_BASE}/${encodeURIComponent(cleaned)}?Fields=line_type_intelligence`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  try {
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (res.status === 404) {
      return { valid: false, mobile: false, e164: null, carrier: null, lineType: null, reason: "not_a_number" };
    }
    if (!res.ok) {
      return { valid: false, mobile: false, e164: null, carrier: null, lineType: null, reason: `lookup_${res.status}` };
    }
    const data = (await res.json()) as {
      valid?: boolean;
      phone_number?: string;
      line_type_intelligence?: { type?: string; carrier_name?: string };
    };
    const lineType = data.line_type_intelligence?.type || null;
    const mobile = lineType === "mobile";
    return {
      valid: !!data.valid,
      mobile,
      e164: data.phone_number || null,
      carrier: data.line_type_intelligence?.carrier_name || null,
      lineType,
      reason: mobile ? undefined : !data.valid ? "invalid" : `line_type_${lineType || "unknown"}`,
    };
  } catch (e) {
    return { valid: false, mobile: false, e164: null, carrier: null, lineType: null, reason: e instanceof Error ? e.message : "lookup_error" };
  }
}
