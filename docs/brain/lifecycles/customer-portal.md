# Customer portal lifecycle

The self-serve customer surface — where logged-in customers manage their subscriptions, orders, payment methods, addresses, returns, and loyalty without contacting support. Two render surfaces share one backend.

## Two surfaces, one backend

| Surface | Where customers see it | Renderer |
|---|---|---|
| **Shopify extension portal** | Embedded in the Shopify customer-account page (when the customer logs into the Shopify storefront) | `shopify-extension/portal-src/` — built into a Shopify customer account extension via `shopify app deploy` |
| **In-house mini-site portal** | `portal.shopcx.ai/{customer-slug}` or per-brand subdomain — accessed via magic link / OTP / shortcode | `src/app/portal/[slug]/page.tsx` — Next.js mini-site |

**Both surfaces hit the same backend.** All portal actions go through `src/app/api/portal/route.ts` which dispatches to the handlers under `src/lib/portal/handlers/`. Auth uses Shopify App Proxy HMAC-SHA256 verification (`src/lib/portal/auth.ts`) for the extension; OTP / magic-link / multipass for the mini-site.

After editing `shopify-extension/portal-src/` files, **always run `node scripts/build-all-portals.js`** — it builds both surfaces from the same source so they don't drift. Then `shopify app deploy` for the extension itself.

## Appstle pricing heal-on-touch

Every Appstle **mutation** (portal action, ticket handler, orchestrator, cron) routes through a heal guard ([[../libraries/appstle-pricing]] `healOnTouch`/`appstleMutate`) that repairs `pricingPolicy: null` subs — the flat baked-price subs Appstle's original migration left behind — *before* acting. It writes a proper base + 25% S&S cycle that **preserves the customer's charge**, so the legacy portal applies the discount on modification and our migration reads clean `basePrice`. Idempotent (no-op once structured), non-fatal. Cancel + migration skip it (migration is heal-by-migration). See [[subscription-billing]] § Migration path.

## Shipping address — one source of truth

`subscriptions.shipping_address` is the **source of truth** for an internal sub. All three paths read it (with the same fallback chain — sub → most recent order → customer `default_address`):
- **Change address** (`portal__handlers__address`) writes it.
- **Renewal** ([[../inngest/internal-subscription-renewals]]) ships + taxes from it — *fixed 2026-06-08*: it used to read the last order only, so a customer's address change never took effect on the next renewal.
- **Checkout** ([[storefront-checkout]]) now persists it on the subscription insert (previously only the order carried it → migrated/portal reads showed "No address on file").
- **Display**: the detail screen loads from `route=subscriptionDetail` (now resolves by **UUID** via the same id-shape branch), which runs the full fallback resolution. The screen no longer pieces data together from the list endpoint — the detail handler is the single source (address + pricing + coupons + payment method + fresh tax in one response).

## Subscription list freshness — no stale state after navigation

**Problem (fixed 2026-07):** when a customer opened a subscription detail page, cancelled the sub, then clicked 'All subscriptions', the list showed only active/paused subs *and* the just-cancelled sub still appeared active (stale). Two root causes: (1) the detail route (`src/app/portal/[slug]/subscriptions/[id]/page.tsx:129`) bootstrapped the subscriptions prop with only `['active','paused']` — excluding cancelled — while the main list page included cancelled; (2) the list's `SubscriptionsSection` was prop-driven and never refetched, so it rendered the pre-cancel snapshot the detail route handed it. The detail route's subs also never ran `priceSubscription`, so internal subs rendered unpriced (`$0`) whenever the list was shown from a detail-page navigation.

**Fix (Phase 1):** the detail route's subscriptions bootstrap now:
- Filters to `['active','paused','cancelled','expired']` — matching the main list page's scope
- Runs `priceSubscription` (same as the main page handler) so the seed is priced, not just image-hydrated

**Fix (Phase 2):** `SubscriptionsSection` now refetches the subscriptions list fresh from the `subscriptions` handler on mount / section-entry, replacing the bootstrap snapshot. The bootstrap prop stays as the first-paint seed (SSR-friendly), but the fresh fetch replaces it so a cancel/pause/reactivate performed on a detail page (or anywhere) shows the correct status on next view — no manual reload. Per-line pricing fixes automatically (the subscriptions handler already returns priced `pricing` via the commerce SDK).

**Mechanics:** on mount, SubscriptionsSection (or the portal client when entering the subscriptions section) calls `GET /api/portal?route=subscriptions` (hitting `src/lib/portal/handlers/subscriptions.ts:195`), which buckets the live list into active/paused/cancelled/other and preserves the same ordering (active-first / paused / cancelled). Both surfaces (extension + mini-site) share this handler.

## Identifier discipline: UUID internally, contract id only at the Appstle edge

A subscription's canonical key is its **UUID** (`subscriptions.id`). `shopify_contract_id` is an *external* detail — numeric for Appstle-billed subs, `internal-<hex>` for subs flipped to internal billing ([[subscription-billing]] § Migration path). It exists only to talk to Appstle.

Every write handler resolves the sub through **`resolveSub(admin, workspaceId, rawId, loggedInShopifyCustomerId)`** in [[../libraries/portal__helpers]]:
- Accepts the UUID **or** the legacy contract-id shape (transitional — both frontends still send `contract.id`).
- Branches by id shape: UUID literals query `subscriptions.id`, anything else queries `shopify_contract_id` (the UUID column can't be compared against a non-UUID literal).
- Enforces the sub belongs to the caller's **link group** — an ownership check the handlers previously lacked.
- Returns the full row; handlers read `sub.id` for DB writes and pass `sub.shopify_contract_id` **only** into Appstle wrapper calls.

**Remove-line-item gotchas (fixed 2026-06):** (1) the "last item" guard counted *real* items (excluding the Shipping Protection add-on) **before** removal and blocked at `≤1` — so toggling Shipping Protection off on a single-product sub wrongly tripped `would_remove_last_item`. It now checks real items remaining *after* the removal, and removing the add-on itself is always allowed while a real product stays. (2) `subRemoveItem` only routes to the internal path when given a `variantId` (`internalSubRemoveItem` keys on it); the handler now passes `variantId` for internal subs instead of `lineGid`, or it would fall through to the Appstle endpoint that has no contract for a migrated sub.

**Stale Appstle line id → variant-id fallback (fixed 2026-06-20):** because `transform-subscription` sets a line's `id` to `line_id || variant_id` (above), an **Appstle** line that surfaced *without* a real Appstle `line_id` reached the portal with `id === variant_id`. The handler trusted any present `lineId` as a `SubscriptionLine` GID for non-internal subs, so it called Appstle with `gid://shopify/SubscriptionLine/<variantId>` and got an unrecoverable `400 "Couldn't find LineId"` (`appstle_error`) — the customer's removal failed repeatedly and escalated a ticket, even though the item was already off the contract. Now [[../libraries/portal__handlers__remove-line-item]] treats `lineId` as a real line GID **only** when it matches a real `line_id` on the resolved items (`isRealLineGid`); otherwise it falls back to `variantId` resolution, which `appstleRemoveLineItem` ([[../libraries/subscription-items]]) handles via a live contract fetch + variant match. And when the numeric variant isn't on the live contract at all, `appstleRemoveLineItem` returns `{ success: true, alreadyAbsent: true }` (idempotent "already removed") instead of the raw GID error, so the portal self-serves and the ticket never escalates. (Ticket `c61858db-8f9a-4076-9beb-75f51f1ff52d` — Bonnie Whitlock, Superfood Tabs on contract 29709598893.)

**Gotcha (fixed 2026-06):** handlers used to parse the id with `clampInt(payload?.contractId, 0)`. That worked while every contract id was numeric, but coerced `internal-<hex>` ids to `0` → `missing_contractId`, breaking *every* action on a migrated sub. The internal-vs-Appstle branch lives in the `appstle*` wrappers ([[../libraries/appstle]]) keyed on the resolved `shopify_contract_id`, so the fix was purely at the handler entry point — no wrapper changes. Because both surfaces share these handlers, the one fix covers both portals.

**Variant-id shape — internal vs Appstle (fixed 2026-06-10):** `replaceVariants` parsed every variant id through `extractNumericId` (`Number()`), which turned an internal sub's catalog **UUID** into `NaN` → the item was dropped → every internal-sub modify (quantity / swap / remove / shipping-protection) failed with `no_changes`, on **the Shopify portal** especially (the in-house portal hit it too). The mutation now branches on sub type and keeps the ref as a **string** (`extractVariantRef` — UUID for internal, numeric for Appstle; the Appstle API body still coerces to `Number`). Two supporting fixes so the generic portal modals work for both: (a) `transform-subscription` sets a line's `id` to `line_id || variant_id`, so internal lines (no Shopify `line_id`) carry the UUID the portal sends back; (b) `replaceVariants` + `removeLineItem` resolve the old item by matching the sent id against **either** `line_id` or `variant_id`. All backend — no portal rebuild (the deployed Shopify portal picks up the new line `id` at runtime). This is the "switch on sub type first" model: Appstle paths do the heavy lifting (heal-on-touch, extra fetches, GraphQL), internal paths just rewrite `subscriptions.items`.

**Portal-error tickets (fixed 2026-06-10):** when a portal action fails the UI says "we're submitting a ticket on your behalf" — but `/api/portal` only logged a `customer_event`, so no ticket existed. It now creates a real **`portal-action-failed`-tagged** ticket (or appends to an open one from the last hour) with the route + error + payload as an internal note, so an agent can finish the action. Validation errors (`no_changes`, `missing_*`, and `insufficient_points` / `/^insufficient points/i`) are skipped — those are UI-gating issues that should never have been offered.

**Auto-heal / dismiss (2026-06-11):** these tickets carry no customer message, so the AI never runs on them. The [[../inngest/portal-action-healer]] cron (every 15 min) triages each open one via [[../libraries/portal__remediation]]: **transient** Appstle errors (operation-lock, gateway) → re-run the action + close; **validation** errors (insufficient points, last-line-item removal) → auto-dismiss; **unrecognized / exhausted** → tag `needs-human` and leave open. Classification keys off the error *message* (the portal wraps every Appstle error as 502, so status is useless), and failure context is pulled latest-wins from the `portal.error` customer_event (a customer who retried a date change three times wants their last requested date). Before re-applying a date change the healer also checks for **self-resolution** — the customer re-did the date themselves, or wanted the order sooner and grabbed it via "Order now" (`orders.subscription_id` on the same sub) — and auto-dismisses instead of mutating a stale date.

**Last-item removal mis-escalation (fixed 2026-06-24):** `remove-line-item` normalizes both its local last-item pre-check and Appstle's live guardrail to `would_remove_last_item` (friendly detail: *"At least one recurring item must remain on the subscription. Cancel the subscription instead."*), and `/api/portal` stores that stable code as the ticket error. The remediation classifier's dismiss branch had only matched the legacy raw Appstle wording (*"at least one subscription product"*), which the handler no longer surfaces — so every customer who tried to empty a single-product sub mis-escalated as an *"Unrecognized portal error"* (real case: ticket `055e807d`, Pam Chadwick). The dismiss branch now matches `would_remove_last_item` (and its replace-variants sibling `would_remove_all_regular_products`, plus the friendly *"at least one recurring item must remain"* detail), so the benign, expected case auto-dismisses. See [[../libraries/portal__remediation]].

**First-delivery mutation gate (2026-06-10 → 2026-06-24):** content/schedule/discount mutations (swap/qty/add/remove, change-date, frequency, coupon, loyalty-apply, shipping-protection) are blocked until the subscription's FIRST order is delivered — anti-gaming. Enforced centrally in the `/api/portal` dispatcher (`MUTATION_GATED_ROUTES`) so it covers **both portals**. The gate now **correctly gates cancel, pause/resume, reactivate, payment-method, and address** as well (was previously skipped; fixed 2026-06-24), making subscriptions fully read-only during the window. `subscription-detail` also returns `portalState.mutationsLocked` + `deliveryState` so the UIs hide all action buttons and show a banner (see Phase 4 below for friendly copy). The 403 gate is treated as a validation result (no error ticket).

**First-delivery banner copy (2026-07):** replaced developer-language "read-only" messaging in the first-delivery gate banner on both portal surfaces (`src/app/portal/[slug]/_sections/SubscriptionDetailScreen.tsx` and `shopify-extension/portal-src/js/screens/SubscriptionDetail.jsx`) with customer-friendly title *"Your subscription is being setup!"* and body *"You can see the details below. Once you receive your first order, you can return here to make changes."* The deliveryState-based title switch was removed in favor of one consistent message. Portal bundles rebuilt (`node scripts/build-all-portals.js` per CLAUDE.md hard rule).

Delivery signal = [[../libraries/portal__mutation-guard]] `canMutateSubscription`: **RENEWAL SHORT-CIRCUIT** — if the subscription has **more than one order**, it's past first delivery and mutations are allowed immediately (no gate); renewal subs always allow modifications. Single-order subs branch by order type: **Shopify orders** (has `shopify_order_id`) use `fulfillment_status` (no EasyPost lookup). **Internal orders** (NULL `shopify_order_id`) use a live EasyPost lookup when tracking exists (throttled 30 min, cached to `orders.delivered_at`/`easypost_status`), or fall back to **7-day grace** — a fulfilled internal order older than 7 days counts as delivered even without tracking (accounts for old/lost tracking or Amplifier orders without EasyPost labels). Fail-open on EasyPost errors. This fix corrects a prior defect where the gate keyed on the **subscription's** `is_internal` flag instead of the **order's** `shopify_order_id`, causing migrated subs (is_internal=true but SC#### Shopify orders) to incorrectly hit the EasyPost path.

**Order status display simplification (2026-06-24):** portal order lists / detail pages render only **THREE terminal states** instead of the prior "in transit"/"processing" limbo that made old/internal orders appear never-received. States are determined per-order by `shopify_order_id` (NULL = internal, Amplifier-sourced): **Created** — paid but not yet shipped (no tracking + not yet fulfilled). **Shipped** — TERMINAL state, reached when the order is fulfilled OR has a tracking number; for internal orders lacking both, the 7-day grace rule applies (fulfilled + >7d old → Shipped, even without tracking). **Delivered** — ONLY when `delivered_at` or EasyPost `delivered` status is confirmed (the portal no longer renders an order as "delivered" without explicit confirmation). Cancelled and Refunded remain SEPARATE financial tags displayed alongside the status. These rules are centralized in a portal-specific order-status helper (`src/lib/portal/order-status.ts`, replacing inline status logic in `OrdersSection` + order-detail) that both the mini-site and Shopify extension share. Portal bundles rebuilt per CLAUDE.md hard rule (`node scripts/build-all-portals.js`). See [[../tables/orders]] for delivery signal details.

**Order detail page + last-5-orders widget (2026-07):** The in-house portal now has a dedicated order-detail route (`src/app/portal/[slug]/orders/[id]/page.tsx`) backed by [[../libraries/portal__handlers__order-detail]] (wraps commerce SDK `detailOrder`), showing the full order surface: line items with product images, honest status badge, totals (subtotal/discount/shipping/tax), tracking link when present, shipping address. The subscription-detail page shows a **Recent orders widget** (last 5 orders tied to that subscription, newest first) via the `recent_orders` field returned by `subscriptionDetail` route — each row is a preview linking to the full detail page. Orders list (`OrdersSection.tsx`) replaced inline expand/collapse with navigation to the order detail page, streamlining the list and centralizing full-order rendering on the dedicated route. The honest status badge remains on each list row for at-a-glance scanning.

**Portal tickets get AI + always-email (2026-06-18):** `supportCreate`/`supportReply` originally inserted a ticket_message but never emitted `ticket/inbound-message`, so the AI never ran — portal tickets sat open. Now both emit the event. The channel is **`portal`** (was mislabeled `help_center`; `scripts/retag-portal-tickets.ts` backfilled existing ones via their `portal.support.ticket_created` event). Portal gets its own **AI Agent Channel config seeded from live chat** (same personality, threshold, turn limit, 15s response delay) and behaves like `chat` for AI (short replies, HTML, journeys/playbooks). **Delivery differs:** every reply on a portal ticket **always emails** the customer a threaded digest — latest message on top, external-only history below ([[../libraries/portal__thread-email]]) — since the customer isn't necessarily watching the portal. See [[../inngest/unified-ticket-handler]] § Channel behavior and [[../libraries/portal__handlers__support]]. **Journeys delivered to a portal-channel ticket** (e.g. Cancel Subscription) hit a dedicated `portal` branch in [[../libraries/journey-delivery]] — the CTA is inserted as an external outbound message *and* emailed via [[../libraries/portal__thread-email]], and delivery is fail-loud (an unmatched channel writes an error note + returns false, never a phantom "delivered").

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
- **Order now** ([[../libraries/portal__handlers__order-now]]) — **internal subs**: fires the `internal-subscription/renewal-attempt` Inngest event, running the exact scheduled-renewal pipeline now (charge → order → Avalara → **Amplifier order** → advance next billing date). Async, so it returns immediately and the order appears shortly. Active subs only. **Appstle subs**: gates the contract on [[../libraries/portal__order-now-guard]] to block cancelled/inactive contracts with a clean 409 (ticket 183d28b9 — migrated subs in a stale Appstle state were surfacing false "out of stock" errors), then attempts the upcoming Appstle billing. (Good way to test the internal renewal end-to-end on demand.)
- **Apply coupon** ([[../libraries/portal__handlers__coupon]]) — paste a code (validates via Shopify discount)
- **Replace variants** ([[../libraries/portal__handlers__replace-variants]]) — flavor swap; preserves grandfathered pricing on like-for-like swaps
- **Remove line item** ([[../libraries/portal__handlers__remove-line-item]]) — drop one item but keep the sub

### Payment methods
- **List** ([[../libraries/portal__handlers__payment-methods]]) — vaulted cards, last4, expiry
- **Add a card** — the Payment Methods page renders the storefront's `HostedFieldsCard` (Braintree Hosted Fields). `route=braintreeClientToken` mints a client token bound to the customer's Braintree customer id (resolve-or-create); tokenize → `route=updatePaymentMethod` vaults the card, **makes it default**, and **migrates the customer's whole book** — `migrateCustomerAppstleSubsToInternal` now sweeps **active, paused, AND cancelled** Appstle subs onto internal rails, **preserving each sub's status** (active→active, paused→paused, cancelled→cancelled; was hardcoded active + active-only). `updatePaymentMethod` resolves-or-creates the Braintree customer so a first card works.
- **Sub-detail payment card** — for **internal** subs the detail screen shows the card the renewal will charge (its **pinned** `subscriptions.payment_method_id` if set, else the link-group default), and offers **"Change card for this subscription"** — a picker of the customer's vaulted Braintree cards (`route=setSubscriptionPaymentMethod`) plus **"+ Add a new card"**. That link deep-links to `/payment-methods?add=1&forSub={subId}`: the page auto-opens the add-card form, vaults the card with `makeDefault:false` + `migrate:false` (so it does NOT become the default or sweep the book), then pins it to that sub via `setSubscriptionPaymentMethod` and returns to the sub. Appstle subs read the last Shopify order's transaction and only get "Manage payment methods".
- **Self-healing migration guard.** On every portal load (`page.tsx`), `ensureGroupMigratedIfBillable` checks the link group: if any Appstle subs remain **and** there's an active default Braintree card, it runs the Appstle→internal migration. Cheap no-op once everything's migrated (one count query); catches stragglers that an earlier (active/paused-only) migration left behind, including cancelled subs.
- **Failed-payment block → inline card-update recovery** ([[../specs/portal-failed-payment-block-exempts-internal-and-offers-inline-card-update]], derived from ticket 115350d5). The change-date + frequency handlers reject on `last_payment_status='failed'` **only** for Appstle subs via [[../libraries/portal__failed-payment-guard]] (see [[subscription-billing]] § Failed-payment mutation block is Appstle-only) — internal subs pass straight through the mutation. When the block DOES fire on an Appstle sub, the real-portal subscription-detail screen renders an inline **"Update payment method"** CTA on the error overlay (no dead-end text) and stashes the in-flight mutation in `sessionStorage` keyed by the sub's **UUID** (invariant across the Appstle→internal migration, which rewrites `shopify_contract_id` to `internal-<hex>`). The CTA deep-links to `/payment-methods?add=1&forSub=<uuid>&retryOnSuccess=1`; the Payment Methods section vaults the card with `migrate: true` so [[../libraries/migrate-to-internal]] sweeps the sub onto internal rails **synchronously**, pins the new card via `setSubscriptionPaymentMethod` (its `is_internal` guard now passes), and redirects back to `/subscriptions/<uuid>?retry=1`. The detail screen consumes the marker, replays the stashed change-date / frequency mutation through the top-level action overlay, and refreshes the contract — the customer's original intent completes in one flow. Distinct from the magic-link `recover=1` path below (that one changes the customer's default + pins the card to every sub + charges immediately + Slack-DMs the team).
- **Payment-recovery magic link** (failed-payment self-serve). `generatePaymentRecoveryLink` ([[../libraries/magic-link]]) builds a signed magic-login URL with `&next=/payment-methods?recover=1`. The customer clicks → auto-logs in (no email/OTP) → lands on Payment Methods with the **add-card form already open** (`recover=1` auto-opens it; nothing to click). On save, `updatePaymentMethod` is called with `recover:true`: vault the card + make it **default** + **migrate the whole book** to internal + **pin the card to every active/paused internal sub** in the link group + **Slack-DM the owners/admins** (`notifyPaymentRecovered`). Then a "You're all set!" success screen. `next` is forwarded through the login flow (`magic-login` validates it's a same-origin relative path → no open redirect). Generate links with `scripts/gen-payment-recovery-link.ts <email>`.
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

### Orders
- **Order detail** ([[../libraries/portal__handlers__order-detail]]) — full order view (order number, placed date, honest status badge, line items with images, totals, shipping address). Read-only. Returns 404 on orders outside the customer's link group. In-house portal only — Shopify extension routes orders via subscription-detail.
  - **Delivery tracking widget** ([[portal-order-detail-tracking-widget]] Phase 3) — renders EasyPost milestone timeline with status/message/datetime/location on INTERNAL orders (shopify_order_id NULL); renders Shopify fulfillment status + tracking number + carrier link on SHOPIFY orders. Only visible on SHIPPED orders; shows "Delivered" state when confirmed. Behind a server-side delivery resolver ([[portal-order-detail-tracking-widget]] Phase 2) that throttles EasyPost lookups to once per UTC day and sets `delivered_at` when confirmed.
- **Recent orders widget** — Last-5-orders list on the subscription detail page (returned in the `subscriptionDetail` route's `recent_orders` field, newest first). Each row is a preview (order number, date, honest status, amount) linking to the full order detail page.

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
- **In-house mini-site** — OTP via [[../integrations/twilio]] Verify (covered in [[storefront-checkout]] Phase 4.5) → sets a signed session cookie. The login (`src/app/portal/[slug]/login/LoginClient.tsx`) mirrors checkout's gate exactly: email → 6-digit code, **SMS-primary** (sent to the on-file `customers.phone`, anti-spoof) with in-modal **"Email me a code instead" / "Text me a code instead"** channel toggles and an **"Email me a login link instead"** magic-link escape hatch. Non-eligible emails (no profile match) fall through to magic-link silently so we don't leak existence. **Phone must be E.164-normalized (`toE164US`) in all three `otp/{start,verify,resend}` routes** — stored numbers are display-formatted (`(858) 334-9198`); verify must hit the same normalized destination start sent to or `verification_check` won't match. `start`/`resend` go through `startVerificationWithFallback` so a failed SMS send **transparently retries over email** (`fell_back: true` → the login shows "couldn't reach your phone, emailed instead" rather than a phantom text). When *both* legs fail (bad number + no/failed email), the send is a handled per-request outcome, **not a server error**: `otp/start` returns `200 {eligible:false, suggest_magic_link:true}` (the client routes to magic-login) and `otp/resend` returns `422` — never a `5xx` — so a single customer's failed OTP no longer pages the owner via the `status >= 500` Vercel-errors feed (Control Tower signature `vercel:202c7bc719d2363f`, fixed 2026-06-22; see [[../libraries/twilio-verify]] Gotchas). **Unlike checkout, the portal login has no guest escape** — auth is required, so the fallback chain (SMS → email code → magic link) is the only way through; there is no "continue without logging in." Magic-link variant for password-reset-style flows. Multipass for Shopify-initiated jumps.

Per [[../operational-rules]] § Identifier discipline in URLs, customer URLs always use the **internal UUID**, never the Shopify customer ID — saved portal links survive the Shopify cutover.

## Shopify → portal SSO (account-drawer handoff)

The Shopify theme is moving its "My Account" surface off the Shopify extension and onto the in-house portal. The theme account drawer (`snippets/account-drawer.liquid`) branches in Liquid on `{% if customer %}`:

- **Logged in →** one CTA to the App Proxy `/apps/portal-v2?route=sso`. The [[../libraries/portal__handlers__sso]] handler reads Shopify's HMAC-verified `logged_in_customer_id`, mints a signed magic-link ([[../libraries/magic-link]]), and 302s the customer into `portal.superfoodscompany.com` already authenticated — **no second login.** Identity is App-Proxy-verified only (never a client-supplied id), so the link can't be forged into account takeover.
- **Logged out →** straight to the bare portal, where they sign in (the login page has a chat widget for anyone stuck — see below).

Below the CTA the drawer shows a "what you can do" showcase (subscriptions, orders, rewards, payment, help center, support) to make the portal inviting. Replaces the old two-link (Orders + Subscriptions) drawer.

**`/pages/portal` redirects too.** The theme app-extension block (`shopify-extension/extensions/subscriptions-portal-theme/blocks/subscription-portal.liquid`) no longer renders the embedded portal SPA — it does the same Liquid `{% if customer %}` branch and `window.location.replace`s to `/apps/portal-v2?route=sso` (logged in) or the bare portal (logged out). So both entry points (header drawer + the `/pages/portal` page) funnel to the in-house portal. Requires `shopify app deploy` to ship. The customer-account extension SPA (`portal-src/`) is now effectively retired on the storefront page; the `subscription-portal.js` asset still ships but isn't loaded by the block.

## Login-page chat widget

The portal **login page only** mounts the same anonymous live-chat widget the storefront + KB mini-site use (`ChatOverlay` → `/widget/{workspaceId}`), gated on `widget_enabled` + `chat_ticket_creation`. It helps people who can't log in (wrong email, no code received) reach a human/AI without being locked out. The authenticated portal does NOT mount it — the Support section already covers logged-in help.

## Help Center section

A "Help Center" sidebar item (`_sections/HelpCenterSection.tsx`) surfaces all published KB articles in-portal, searchable, without leaving. Reuses the public help APIs: list via `GET /api/help/{help_slug}?search=` (title+content ilike), inline reader via `GET /api/widget/{workspaceId}/articles/{id}` (`content_html` in a `prose` wrapper). `help` is whitelisted in the middleware `PORTAL_SECTIONS` set for a clean `/help` URL. Distinct from **Support** (ticket submission) and **Resources** (blog product guides).

## Resources section (blog product guides)

A "Resources" sidebar item (`_sections/ResourcesSection.tsx`) surfaces the imported Superfood-Scoop blog as product guides — a **search bar** + **product → grouping** (Recipes / How it works / How to use / Science) two-level navigation + an inline reader rendering the post's `content_html` (our hosted images). Reads [[../tables/posts]] (`is_resource` + `published`) via [[../tables/post_products]]; a post linked to multiple products appears under each. Distinct from **Help Center** (KB articles) and **Support** (tickets). Full flow — import, AI classification, public storefront blog, admin view — in [[blog-resources]].

### Host-rewrite nav model (the prefix gotcha)

The mini-site runs on a **custom domain** (`portal.{brand}.com`). `src/proxy.ts` middleware (`updateSession`) rewrites `/portal/{slug}/*` → `/*` for that host **only**, so on the live domain every internal path is root-relative (`/`, `/logout`, `/subscriptions`). On **localhost and path-based `shopcx.ai/portal/{slug}`** there is NO rewrite — the portal lives under `/portal/{slug}` and a bare root path (`/`, `/logout`) escapes the portal and hits the **admin app**, which bounces to its own `/login`. This bit us twice (post-OTP redirect, and the Sign-out link).

- **Hard navigations must go through `portalHref()`** (`src/lib/portal-nav.ts`) — it keeps the `/portal/{slug}` prefix when the rewrite isn't in play (detected from `window.location.pathname`) and stays prefix-free on the custom domain. Used by the login success redirect, the magic-token auto-login redirect, and the Sign-out link (`portal-client.tsx` keeps `href="/logout"` for no-JS/custom-domain and corrects it on click). In-session SPA section nav uses `history.pushState` and is exempt.
- **Logout is a Route Handler** (`src/app/portal/[slug]/logout/route.ts`), NOT a page. App Router forbids cookie mutation during a Server Component render ("Cookies can only be modified in a Server Action or Route Handler"). It clears `portal_customer_id` / `portal_workspace_id` / `portal_session` via `Set-Cookie` on a 307 redirect (honored before the browser follows) and targets `/login` on the custom domain, `/portal/{slug}/login` otherwise.
- **OTP-start needs `workspace_id` in the body** — the route's host-based workspace resolution fails on localhost/path-based hosts, so the login page passes the server-resolved `workspaceId` into `LoginClient`, which sends it to `otp/start` + `magic-login`. Host resolution stays as the custom-domain fallback.

## Cancel → journey, not hard cancel

When a customer clicks "Cancel subscription" in the portal, the handler does NOT hard-cancel. Instead it triggers the cancel journey ([[cancel-flow]]) — AI-selected remedies, social proof, save offers. Only if the customer completes the journey saying "still cancel" does the actual cancel fire via Appstle's DELETE endpoint with `cancellationFeedback`.

## Status / open work

**Shipped:** Both surfaces (Shopify extension + in-house mini-site). All listed handlers wired. Cancel-via-journey. Loyalty redeem + apply. Coupon validation. Address + frequency + line-item mutations. Payment method update with Appstle → internal migration on card change. Identity linking. Event log + internal ticket notes.

**Shipped 2026-06-17 — Shopify→portal handoff:** the account drawer + `/pages/portal` (theme app extension `shopcx-98`) redirect to the in-house portal — logged-in via the App-Proxy SSO route (`route=sso` handler → magic-link → authenticated, no second login), logged-out → bare portal. Drawer = 1 CTA + capability showcase ([[../recipes/edit-shopify-theme]]). Login-page anonymous chat widget. Help Center sidebar (product cards + General). Orders list: stale "Processing" hidden on >2-month-old orders, line-item prices read `price_cents × qty` (0 omitted, not "$0.00").

**Shipped 2026-06-20 — Commerce SDK migration (M5):** portal read handlers migrated to `commerce/subscription.getSubscription` + `listSubscriptions` + `commerce/price.priceSubscription`. Portal mutation handlers (order-now, coupon, address, cancel, change-date, swap variants, loyalty) now route through the Commerce SDK (subscription-action, coupon, loyalty, etc.). Both surfaces (extension + mini-site) rebuilt and verified byte-exact parity via `scripts/commerce-diff-run.ts`. Legacy appstle.ts + subscription-items.ts shims retired where the portal no longer references them. Portal is now a thin consumer of the Commerce SDK, enforcing the outcome invariant: zero direct commerce reads/writes in customer-facing surfaces.

**Shipped 2026-07-08 — Failed-payment block scoped to Appstle + inline card-update recovery** ([[../specs/portal-failed-payment-block-exempts-internal-and-offers-inline-card-update]], ticket 115350d5). Change-date + frequency guards now check `is_internal` (internal subs are exempt); the real portal renders an inline "Update payment method" CTA on the block that migrates the Appstle sub to internal via [[../libraries/migrate-to-internal]], pins the new card, and auto-replays the previously-blocked mutation — customer completes their original intent in one flow instead of hitting a text dead-end. Shopify-extension portal is sunset and out of scope. See § Payment methods · Failed-payment block → inline card-update recovery above.

**Shipped 2026-07-06 — Portal order detail delivery tracking (Phase 3):** order detail page now shows delivery tracking widget. INTERNAL orders render EasyPost milestone timeline (status + message + datetime + location). SHOPIFY orders render fulfillment status + tracking number + carrier link. Behind a server-side delivery resolver ([[portal-order-detail-tracking-widget]] Phase 2) that throttles EasyPost lookups to once per UTC day (cached to `orders.easypost_tracking`), syncs Shopify fulfillments on-demand (free), and sets `delivered_at` on confirmation. Only visible on shipped orders; fails open (no widget) on EasyPost errors.

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
| `src/lib/portal/handlers/sso.ts` | Shopify App-Proxy → magic-link 302 SSO ([[../libraries/portal__handlers__sso]]) |
| `src/lib/portal/handlers/order-detail.ts` | Order detail route — wrapped commerce SDK read ([[../libraries/portal__handlers__order-detail]]) |
| `src/app/portal/[slug]/orders/[id]/page.tsx` | Order detail page render (Phase 1 [[portal-order-detail-page-widget-and-friendly-copy]]) |
| `src/app/portal/[slug]/_sections/order-status.ts` | Honest three-state order status classifier (Created/Shipped/Delivered + financial tags) |
| `src/app/portal/[slug]/_sections/OrdersSection.tsx` | Order list with navigation to detail page (Phase 3, replaced inline expand/collapse) |
| `src/app/portal/[slug]/_sections/SubscriptionDetailScreen.tsx` | Subscription detail + recent-orders widget (Phase 2, Phase 4 friendly copy) |
| `shopify-extension/portal-src/js/screens/SubscriptionDetail.jsx` | Shopify extension subscription detail + friendly copy (Phase 4) |
| `src/app/portal/[slug]/_sections/HelpCenterSection.tsx` | In-portal searchable KB browser |
| `src/app/portal/[slug]/login/LoginClient.tsx` | Login form + login-help chat widget |
| `src/lib/portal/helpers.ts` | Response helpers, event logging, Appstle error handling |
| `src/app/api/portal/otp/*` | OTP start / verify / resend for the mini-site |
| `src/app/api/portal/magic-login/route.ts` | Magic-link auth |
| `src/app/api/portal/multipass-login/route.ts` | Shopify Multipass entry |
| `scripts/build-all-portals.js` | Builds BOTH surfaces from one source |

## Related

[[cancel-flow]] · [[dunning]] · [[storefront-checkout]] · [[blog-resources]] · [[customer-link-confirmation]] · [[../libraries/portal__handlers__index]] · [[../libraries/portal__failed-payment-guard]] · [[../libraries/client-error-reporter]] · [[../integrations/twilio]] · [[../integrations/braintree]] · [[../integrations/shopify]] · [[../tables/customer_events]] · [[../tables/auth_otp_sessions]]

Both portal surfaces (in-house `portal/[slug]/layout.tsx` + the Shopify-extension Preact bundle) report client-side render crashes to `/api/client-errors` as `error_events` `source='client'`, `surface='portal'` — the Preact bundle posts cross-origin to the absolute app origin. See [[../libraries/client-error-reporter]].
