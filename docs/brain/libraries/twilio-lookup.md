# libraries/twilio-lookup

Twilio Lookup line-type intelligence — gates phone capture in the smart popup (storefront-mvp Phase 4e).

**File:** `src/lib/twilio-lookup.ts`

`lookupPhone(phone)` → `{ valid, mobile, e164, carrier, lineType, reason }`. Uses the global Twilio account creds (`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`, same as [[twilio]]). Calls `GET lookups.twilio.com/v2/PhoneNumbers/{n}?Fields=line_type_intelligence`.

**Mobile-only, fail-closed:** `/api/popup/claim` only delivers the SMS coupon when `mobile === true` (blocks landline + VoIP — the stricter, cleaner choice). Any API error returns `mobile:false` so a Lookup outage can't leak the discount to unverified numbers or pollute the SMS list.

---

[[../README]] · [[twilio]] · [[popup-decide]] · [[../lifecycles/storefront-checkout]] · [[../../CLAUDE]]
