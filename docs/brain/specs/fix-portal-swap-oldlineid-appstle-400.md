# Portal item swap fails with Appstle 400 — oldLineId built from a non-line id ✅

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `11746b62-8e6b-4e18-9c39-498ee12401d6`

Make customer-initiated subscription swaps in the portal use the reliable oldVariants path for Appstle subs instead of synthesizing a SubscriptionLine GID. The portal swap UI sends oldLineId = the line's id (shopify-extension/portal-src/js/modals/AddSwapModal.jsx:98 and src/app/portal/[slug]/_sections/SubscriptionDetailScreen.tsx:932), but transformSubscription (src/lib/portal/helpers/transform-subscription.ts:85) sets line.id = item.line_id || variant_id, which for Appstle subs is often a UUID or the variant id — not a real Shopify SubscriptionLine id. replaceVariants (src/lib/portal/handlers/replace-variants.ts:131) then wraps it as gid://shopify/SubscriptionLine/<x> and Appstle rejects it with 400. Fix: in the handler, when the sub is Appstle and oldLineId is not a real Shopify line GID, resolve it to the line's variant_id from subscriptions.items and send oldVariants instead (the same approach subSwapVariant at src/lib/subscription-items.ts:585 already uses successfully). The handler already loads items to resolve oldVariantId for grandfathered pricing, so the lookup exists.

## Problem (from ticket `11746b62-8e6b-4e18-9c39-498ee12401d6`)
Customer Jessica Ollet tried to swap Amazing Coffee instant → K-Cups in the portal and it failed twice with appstle_error 400, with no path to self-serve; the swap silently never happened and required manual repair. Any Appstle-sub customer doing a portal swap can hit this.

## Phases
- ✅ **P1 — implement the fix** — `src/lib/portal/handlers/replace-variants.ts`: for Appstle subs, when `oldLineId` isn't already a real `gid://shopify/SubscriptionLine/…` GID, resolve it to the line's `variant_id` from `subscriptions.items` and send `oldVariants` instead of synthesizing a `SubscriptionLine` GID. Falls back to the legacy synthesized GID only when no variant id resolves. Also made the grandfathered-pricing and event-logging `oldLineId` lookups match on `variant_id` (not just `line_id`), so they resolve when `oldLineId` is actually a variant id. Brain page [[../libraries/portal__handlers__replace-variants]] updated. Gated on `npx tsc --noEmit` (clean).

## Verification
- On the customer portal subscription detail screen (`/portal/[slug]`), as an **Appstle** subscriber whose line has no real Shopify `SubscriptionLine` id, swap one line item to another variant (e.g. Amazing Coffee instant → K-Cups) → expect the swap to **succeed** (no `appstle_error` 400), the line to show the new variant, and `subscriptions.items` to reflect it.
- In the network call `POST /api/portal?route=replaceVariants` for that swap → expect the handler to send Appstle `oldVariants: [<numeric variant id>]` (not `oldLineId: gid://shopify/SubscriptionLine/<x>`).
- Reproduce the original ticket scenario (Jessica Ollet) → expect the self-serve swap to complete without manual repair.
- Regression: an internal (non-Appstle) sub swap via the portal → expect it still routes through the internal branch and succeeds; and an Appstle swap where `oldLineId` is a genuine `gid://shopify/SubscriptionLine/…` GID → expect it still sends `oldLineId` unchanged.

> Authored by the box Improve agent from ticket `11746b62-8e6b-4e18-9c39-498ee12401d6`. Commission the build from the Roadmap board (owner = cs).
