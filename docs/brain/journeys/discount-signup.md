# Discount & Marketing Signup

Captures email + SMS marketing consent in exchange for a coupon. The most-fired auto-trigger journey.

DB row in [[../tables/journey_definitions]]: `slug='discount_signup'`, `journey_type='discount_signup'`, `trigger_intent='discount_signup'`.

## Trigger

- **trigger_intent**: `discount_signup`
- **match_patterns**: `discount`, `coupon`, `deal`, `promo`, `promotion`, `save`, `code`, `sale`, `specials`
- **priority**: 50

## Channels

`email`, `chat`, `help_center`, `meta_dm`, `sms`. (Not `social_comments`.)

## Steps

Built by `src/lib/discount-journey-builder.ts`:

1. **Consent** — "Want to sign up for coupons + early access?" Yes / No.
   - On Yes → continue. On No → bail to re-nudge logic.
2. **Phone input** — only if no phone on file. Auto-formats `(858) 334-9198` as user types, validates via [[../integrations/twilio]] Lookup v2 (rejects landlines).
3. **Apply to subscription** — only if customer has an active sub that doesn't already have a coupon.

If the customer has linked accounts, account-linking steps are silently **prepended** as Step 0 (see [[account-linking]] + [[../journeys/README]] "Account linking is a prepend").

## Consent → action

On Yes:

1. [[../integrations/shopify]] `customerEmailMarketingConsentUpdate` (subscribed).
2. If phone on file or just entered → `customerSmsMarketingConsentUpdate` (subscribed).
3. Pick the coupon code from [[../tables/coupon_mappings]] based on customer's VIP tier (`all` / `vip` / `non_vip`). Default workspace code: `SHOPCX`.
4. If customer has an active sub and chose to apply the coupon → [[../integrations/appstle]] `applyDiscountWithReplace()` (removes any existing coupon first; one coupon per sub).
5. Send the coupon delivery message:
   - Styled code block with click-to-copy.
   - Threaded into the existing ticket conversation via [[../integrations/resend]] `In-Reply-To`.

## Re-nudge for declines

Per [[../journeys/README]] "No coupon without signup":

- **First decline** (`tickets.journey_nudge_count = 0`):
  - Mini-site/chat shows: "Check your email shortly for a response from our team!"
  - Server sends new CTA email with nudge wording.
  - Increment `journey_nudge_count = 1`.
- **Second decline** (`journey_nudge_count = 1`):
  - Close the ticket.
  - Clear journey state.
  - AI takes over on next reply.

`journey_nudge_count` resets to 0 when the customer completes a step via the mini-site (engagement signal).

## Phone validation

- Lookup v2 with `line_type_intelligence` rejects `landline` / `voip` with a clear error.
- Auto-prepends `+1` for US numbers on server side.
- E.164 stored on [[../tables/customers]].`phone`.

## Outcomes

| Tag | When |
|---|---|
| `j:discount_signup` | Always |
| `jo:positive` | Customer signed up + coupon delivered |
| `jo:negative` | Customer declined twice |
| `jr:discount` | Re-nudge sent |
| `link` | Customer linked accounts during the journey |

## Multi-step response storage

Steps use `key` (e.g. `key: "consent"`, `key: "phone"`) not `id` — the mini-site's response storage looks at `form.id || form.key`. See [[../journeys/README]] gotcha "Multi-step responses stored as `{"undefined": ...}`" — using `form.id` alone silently breaks marketing subscriptions, coupon applications, and action logging. Always coalesce.

## Step ticket status

`closed` per the DB row — the ticket auto-closes after each step. Reopens when the customer responds via the mini-site.

## Files

| File | Purpose |
|---|---|
| `src/lib/discount-journey-builder.ts` | Single source of truth for steps |
| `src/lib/marketing-signup-journey-builder.ts` | Closely related signup builder used in some contexts |
| `src/lib/email-journey-builder.ts` | Combined builder (account linking + discount) for email channel |
| `src/lib/journey-launcher.ts` | Launcher |
| `src/lib/journey-delivery.ts` | Channel delivery |
| `src/lib/marketing-coupons.ts` | Coupon code resolution by VIP tier |
| `src/lib/shopify-marketing.ts` | Email + SMS marketing consent mutations |
| `src/lib/appstle-discount.ts` | applyDiscountWithReplace |
| `src/app/journey/[token]/page.tsx` | Mini-site renderer |
| `src/app/api/journey/[token]/complete/route.ts` | Subscribe + apply coupon + tag |
| `src/app/api/validate-phone/route.ts` | Twilio Lookup v2 |

## Related

[[account-linking]] · [[cancel]] · [[../tables/journey_definitions]] · [[../tables/journey_sessions]] · [[../tables/coupon_mappings]] · [[../tables/customers]] · [[../integrations/shopify]] · [[../integrations/twilio]] · [[../integrations/appstle]] · [[../integrations/resend]]
