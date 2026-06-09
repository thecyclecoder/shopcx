# Customer portal lifecycle

The self-serve customer surface — where logged-in customers manage their subscriptions, orders, payment methods, addresses, returns, and loyalty without contacting support. Two render surfaces share one backend.

## Two surfaces, one backend

| Surface | Where customers see it | Renderer |
|---|---|---|
| **Shopify extension portal** | Embedded in the Shopify customer-account page (when the customer logs into the Shopify storefront) | `shopify-extension/portal-src/` — built into a Shopify customer account extension via `shopify app deploy` |
| **In-house mini-site portal** | `portal.shopcx.ai/{customer-slug}` or per-brand subdomain — accessed via magic link / OTP / shortcode | `src/app/portal/[slug]/page.tsx` — Next.js mini-site |

**Both surfaces hit the same backend.** All portal actions go through `src/app/api/portal/route.ts` which dispatches to the handlers under `src/lib/portal/handlers/`. Auth uses Shopify App Proxy HMAC-SHA256 verification (`src/lib/portal/auth.ts`) for the extension; OTP / magic-link / multipass for the mini-site.

After editing `shopify-extension/portal-src/` files, **always run `node scripts/build-all-portals.js`** — it builds both surfaces from the same source so they don't drift. Then `shopify app deploy` for the extension itself.

## Shipping address — one source of truth

`subscriptions.shipping_address` is the **source of truth** for an internal sub. All three paths read it (with the same fallback chain — sub → most recent order → customer `default_address`):
- **Change address** (`portal__handlers__address`) writes it.
- **Renewal** ([[../inngest/internal-subscription-renewals]]) ships + taxes from it — *fixed 2026-06-08*: it used to read the last order only, so a customer's address change never took effect on the next renewal.
- **Checkout** ([[storefront-checkout]]) now persists it on the subscription insert (previously only the order carried it → migrated/portal reads showed "No address on file").
- **Display**: the detail screen loads from `route=subscriptionDetail` (now resolves by **UUID** via the same id-shape branch), which runs the full fallback resolution. The screen no longer pieces data together from the list endpoint — the detail handler is the single source (address + pricing + coupons + payment method + fresh tax in one response).

## Identifier discipline: UUID internally, contract id only at the Appstle edge

A subscription's canonical key is its **UUID** (`subscriptions.id`). `shopify_contract_id` is an *external* detail — numeric for Appstle-billed subs, `internal-<hex>` for subs flipped to internal billing ([[../specs/storefront-mvp]] § 1c migration). It exists only to talk to Appstle.

Every write handler resolves the sub through **`resolveSub(admin, workspaceId, rawId, loggedInShopifyCustomerId)`** in [[../libraries/portal__helpers]]:
- Accepts the UUID **or** the legacy contract-id shape (transitional — both frontends still send `contract.id`).
- Branches by id shape: UUID literals query `subscriptions.id`, anything else queries `shopify_contract_id` (the UUID column can't be compared against a non-UUID literal).
- Enforces the sub belongs to the caller's **link group** — an ownership check the handlers previously lacked.
- Returns the full row; handlers read `sub.id` for DB writes and pass `sub.shopify_contract_id` **only** into Appstle wrapper calls.

**Remove-line-item gotchas (fixed 2026-06):** (1) the "last item" guard counted *real* items (excluding the Shipping Protection add-on) **before** removal and blocked at `≤1` — so toggling Shipping Protection off on a single-product sub wrongly tripped `would_remove_last_item`. It now checks real items remaining *after* the removal, and removing the add-on itself is always allowed while a real product stays. (2) `subRemoveItem` only routes to the internal path when given a `variantId` (`internalSubRemoveItem` keys on it); the handler now passes `variantId` for internal subs instead of `lineGid`, or it would fall through to the Appstle endpoint that has no contract for a migrated sub.

**Gotcha (fixed 2026-06):** handlers used to parse the id with `clampInt(payload?.contractId, 0)`. That worked while every contract id was numeric, but coerced `internal-<hex>` ids to `0` → `missing_contractId`, breaking *every* action on a migrated sub. The internal-vs-Appstle branch lives in the `appstle*` wrappers ([[../libraries/appstle]]) keyed on the resolved `shopify_contract_id`, so the fix was purely at the handler entry point — no wrapper changes. Because both surfaces share these handlers, the one fix covers both portals.

## Self-serve actions available

All routes are `/api/portal?route={name}` (App Proxy on the Shopify side) or POST to the same endpoint from the mini-site.

### Subscription management
- **List** ([[../libraries/portal__handlers__subscriptions]]) — all active + paused subs, including linked accounts. DB-first read from [[../tables/subscriptions]] (Appstle only for mutations).
- **Detail** ([[../libraries/portal__handlers__subscription-detail]]) — items, billing date, pricing breakdown, recovery status, payment method.
- **Pause** ([[../libraries/portal__handlers__pause]]) — pause until customer resumes
- **Resume** ([[../libraries/portal__handlers__resume]]) — reactivate paused sub
- **Reactivate** ([[../libraries/portal__handlers__reactivate]]) — un-cancel a cancelled sub (within reactivation window)
- **Cancel** ([[../libraries/portal__handlers__cancel]] → triggers cancel journey, NOT a hard cancel)
- **Cancel journey flow** ([[../libraries/portal__handlers__cancel-journey]]) — full AI-driven retention flow per [[cancel-flow]]
- **Change date** ([[../libraries/portal__handlers__change-date]]) — pick a new next-billing date
- **Change frequency** ([[../libraries/portal__handlers__frequency]]) — monthly → bimonthly etc.
- **Order now** ([[../libraries/portal__handlers__order-now]]) — fire an immediate billing attempt
- **Apply coupon** ([[../libraries/portal__handlers__coupon]]) — paste a code (validates via Shopify discount)
- **Replace variants** ([[../libraries/portal__handlers__replace-variants]]) — flavor swap; preserves grandfathered pricing on like-for-like swaps
- **Remove line item** ([[../libraries/portal__handlers__remove-line-item]]) — drop one item but keep the sub

### Payment methods
- **List** ([[../libraries/portal__handlers__payment-methods]]) — vaulted cards, last4, expiry
- **Add a card** — the Payment Methods page renders the storefront's `HostedFieldsCard` (Braintree Hosted Fields). `route=braintreeClientToken` mints a client token bound to the customer's Braintree customer id (resolve-or-create); tokenize → `route=updatePaymentMethod` vaults the card, **makes it default**, and **migrates the customer's whole book** — `migrateCustomerAppstleSubsToInternal` now sweeps **active, paused, AND cancelled** Appstle subs onto internal rails, **preserving each sub's status** (active→active, paused→paused, cancelled→cancelled; was hardcoded active + active-only). `updatePaymentMethod` resolves-or-creates the Braintree customer so a first card works.
- **Sub-detail payment card** — for **internal** subs the detail screen shows the card the renewal will charge (its **pinned** `subscriptions.payment_method_id` if set, else the link-group default), and offers **"Change card for this subscription"** — a picker of the customer's vaulted Braintree cards (`route=setSubscriptionPaymentMethod`) plus **"+ Add a new card"**. That link deep-links to `/payment-methods?add=1&forSub={subId}`: the page auto-opens the add-card form, vaults the card with `makeDefault:false` + `migrate:false` (so it does NOT become the default or sweep the book), then pins it to that sub via `setSubscriptionPaymentMethod` and returns to the sub. Appstle subs read the last Shopify order's transaction and only get "Manage payment methods".
- **One default per person.** `savePaymentMethod` clears defaults across the **link group** (not per profile) and the default lookups (renewal fallback + sub-detail display) span the group — so a person has exactly one default even if their cards sit on different linked profiles.
- **Update** — adds a new vaulted card via Braintree Hosted Fields; switches default; migrates the sub off Appstle's gateway to internal Braintree where applicable (Appstle → Internal migration path on update)

### Identity
- **Bootstrap** ([[../libraries/portal__handlers__bootstrap]]) — initial state fetch on portal open (customer + subs + orders + payment + loyalty + recent tickets)
- **Account info** ([[../libraries/portal__handlers__account]]) — name / email / phone editor
- **Address** ([[../libraries/portal__handlers__address]]) — shipping address editor
- **Link accounts** ([[../libraries/portal__handlers__link-accounts]]) — confirm a suggested account link

### Loyalty / Rewards
- **Rewards section** (`_sections/RewardsSection.tsx`) — a dedicated sidebar nav item (`/rewards`, allowlisted in `PORTAL_SECTIONS`): points hero + redemption tiers (with progress) + minted coupons + "how it works" program details + fine print (points earn on the post-discount **product** subtotal — not tax/shipping). The `RewardsCard` on the sub-detail page stays too.
- **Balance** ([[../libraries/portal__handlers__loyalty-balance]]) — points balance + program copy (earn rate, redemption rate, coupon lifetime). **Aggregates points across the UUID link group** — linked accounts are one person, so the balance is the SUM across sibling member rows (fixed a 0-points bug where the direct Shopify-id match returned a 0-pt sibling). Loyalty identity is the **customer UUID**, never the Shopify id; `getOrCreateMember` keys on `customer_id` so earning consolidates onto one member per person.
- **Redeem** ([[../libraries/portal__handlers__loyalty-redeem]]) — spend points → generates Shopify discount code
- **Apply to subscription** ([[../libraries/portal__handlers__loyalty-apply-subscription]]) — apply a redeemed loyalty coupon to a sub

### Other
- **Home** ([[../libraries/portal__handlers__home]]) — landing surface
- **Reviews** ([[../libraries/portal__handlers__reviews]]) — Klaviyo product reviews for the customer's purchased products (drives social proof on cancel journey)
- **Support tickets list + reply** ([[../libraries/portal__handlers__support]]) — view + reply to open tickets
- **Dunning status** ([[../libraries/portal__handlers__dunning-status]]) — current dunning cycle if in recovery (per [[dunning]])
- **Ban request** ([[../libraries/portal__handlers__ban-request]]) — customer-initiated request to ban / unsubscribe entirely

## Event logging

Every portal action logs to [[../tables/customer_events]] (event_type `portal.subscription.paused`, `portal.items.swapped`, `portal.coupon.applied`, etc.). Mutation actions ALSO create an internal note on a ticket (so agents see the activity context when the customer later messages in).

## Auth boundaries

- **Shopify extension** — Shopify App Proxy signs every request with HMAC-SHA256 using `SHOPIFY_APP_PROXY_SECRET`. The handler verifies the signature + resolves workspace from the shop domain. Customer ID is in the proxy payload.
- **In-house mini-site** — OTP via [[../integrations/twilio]] Verify (covered in [[storefront-checkout]] Phase 4.5) → sets a signed session cookie. Magic-link variant for password-reset-style flows. Multipass for Shopify-initiated jumps.

Per [[../operational-rules]] § Identifier discipline in URLs, customer URLs always use the **internal UUID**, never the Shopify customer ID — saved portal links survive the Shopify cutover.

## Cancel → journey, not hard cancel

When a customer clicks "Cancel subscription" in the portal, the handler does NOT hard-cancel. Instead it triggers the cancel journey ([[cancel-flow]]) — AI-selected remedies, social proof, save offers. Only if the customer completes the journey saying "still cancel" does the actual cancel fire via Appstle's DELETE endpoint with `cancellationFeedback`.

## Status / open work

**Shipped:** Both surfaces (Shopify extension + in-house mini-site). All listed handlers wired. Cancel-via-journey. Loyalty redeem + apply. Coupon validation. Address + frequency + line-item mutations. Payment method update with Appstle → internal migration on card change. Identity linking. Event log + internal ticket notes.

**Known gaps / not yet shipped:** None identified.

**Recent activity:**
- `cf5ed633` CSAT: 'Create ticket from this comment' button + fires orchestrator (cross-system)

**Open questions:** None.

## Files touched

| File | Purpose |
|---|---|
| `shopify-extension/portal-src/` | Shopify customer-account-extension renderer |
| `src/app/portal/[slug]/page.tsx` | In-house mini-site portal page |
| `src/app/api/portal/route.ts` | Main API entry, dispatches to handlers |
| `src/lib/portal/auth.ts` | HMAC verification + workspace resolution |
| `src/lib/portal/handlers/*` | Per-action handlers (one per route name) |
| `src/lib/portal/helpers.ts` | Response helpers, event logging, Appstle error handling |
| `src/app/api/portal/otp/*` | OTP start / verify / resend for the mini-site |
| `src/app/api/portal/magic-login/route.ts` | Magic-link auth |
| `src/app/api/portal/multipass-login/route.ts` | Shopify Multipass entry |
| `scripts/build-all-portals.js` | Builds BOTH surfaces from one source |

## Related

[[cancel-flow]] · [[dunning]] · [[storefront-checkout]] · [[customer-link-confirmation]] · [[../libraries/portal__handlers__index]] · [[../integrations/twilio]] · [[../integrations/braintree]] · [[../integrations/shopify]] · [[../tables/customer_events]] · [[../tables/auth_otp_sessions]]
