# Account Linking

A prepend journey — silently inserted as Step 0 of another journey. Never standalone. The CTA email focuses on the main journey ("Claim my coupon"), and the linking step appears first inside the mini-site.

DB row in [[../tables/journey_definitions]]: `slug='account_linking'`, `journey_type='account_linking'`, `trigger_intent='account_linking'`, `match_patterns=[]`.

## Trigger

- **trigger_intent**: `account_linking`
- **match_patterns**: **empty** — never fires from a customer message directly.
- **priority**: 100 (low — only kicks in when prepended).

The empty `match_patterns` is intentional. Account linking solo doesn't make sense as a customer-facing call-to-action — "click here to verify these other emails" without context is friction with no obvious benefit. It always rides on another journey's CTA.

## When it prepends

When another journey is about to launch ([[discount-signup]], [[cancel]], etc.), the builder runs an unlinked-account check:

1. Look for [[../tables/customers]] rows matching the current customer's first + last name (case-insensitive) in the same workspace.
2. Filter out customers already in the same [[../tables/customer_links]] group.
3. Filter out customers in [[../tables/customer_link_rejections]] for this customer.
4. If candidates remain, prepend account-linking step(s) to the journey session.

`src/lib/account-linking-journey-builder.ts` is the builder. `src/lib/email-journey-builder.ts` is the combiner.

## Channels

`email`, `chat`, `help_center`, `meta_dm`, `sms`. (Not `social_comments`.)

But again — it only prepends; it never gets delivered on its own.

## Steps

1. **Checklist of candidate emails** — the mini-site shows a list of names + email addresses (e.g. "Dylan Ralston · dylan@gmail.com"), each with a checkbox.
2. **Customer ticks the ones that are theirs.**

## On submit

- For each ticked candidate → insert [[../tables/customer_links]] row with the same `group_id`. Mint a new `group_id` if neither customer is linked; reuse the existing one if either is.
- For each unticked candidate → insert [[../tables/customer_link_rejections]] row to permanently exclude. We **never re-offer** rejected links.
- Add internal note: `[System] Accounts linked: dylan@gmail.com ↔ current customer.`
- Tag the ticket `link`.
- Continue to the next step of the parent journey.

## Marketing consent rule

After linking, marketing decisions still key off the **main** customer (the one initiating the journey), NOT the linked accounts. Email subscribes the main customer's email; phone subscribes the main customer's phone. Linked accounts' marketing status is not changed by this journey.

See JOURNEYS.md "Main account only for marketing decisions."

## Outcomes

| Tag | When |
|---|---|
| `link` | Customer ticked at least one |

No `jo:*` tags — the outcome is rolled into the parent journey's outcome (a saved cancellation that linked accounts is `jo:positive` on cancel, with `link` as an additional tag).

## Step ticket status

`closed` per the DB row — same as the parent journey usually.

## Files

| File | Purpose |
|---|---|
| `src/lib/account-linking-journey-builder.ts` | The builder |
| `src/lib/email-journey-builder.ts` | Combines account-linking + main journey for email |
| `src/lib/account-matching.ts` | Fuzzy name match heuristics |
| `src/lib/auto-link-customer-from-message.ts` | Auto-link from message-extracted hints |
| `src/lib/customer-events.ts` | Logs linking events |
| `src/app/journey/[token]/page.tsx` | Mini-site renderer (checklist UI) |
| `src/app/api/journey/[token]/complete/route.ts` | Insert customer_links + rejections |

## Related

[[../lifecycles/customer-link-confirmation]] · [[discount-signup]] · [[cancel]] · [[../tables/customer_links]] · [[../tables/customer_link_rejections]] · [[../tables/customers]] · [[../tables/journey_definitions]]
