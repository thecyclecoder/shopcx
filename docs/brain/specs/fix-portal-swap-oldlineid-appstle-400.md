# Portal item swap fails with Appstle 400 — oldLineId built from a non-line id ⏳

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `11746b62-8e6b-4e18-9c39-498ee12401d6`

Make customer-initiated subscription swaps in the portal use the reliable oldVariants path for Appstle subs instead of synthesizing a SubscriptionLine GID. The portal swap UI sends oldLineId = the line's id (shopify-extension/portal-src/js/modals/AddSwapModal.jsx:98 and src/app/portal/[slug]/_sections/SubscriptionDetailScreen.tsx:932), but transformSubscription (src/lib/portal/helpers/transform-subscription.ts:85) sets line.id = item.line_id || variant_id, which for Appstle subs is often a UUID or the variant id — not a real Shopify SubscriptionLine id. replaceVariants (src/lib/portal/handlers/replace-variants.ts:131) then wraps it as gid://shopify/SubscriptionLine/<x> and Appstle rejects it with 400. Fix: in the handler, when the sub is Appstle and oldLineId is not a real Shopify line GID, resolve it to the line's variant_id from subscriptions.items and send oldVariants instead (the same approach subSwapVariant at src/lib/subscription-items.ts:585 already uses successfully). The handler already loads items to resolve oldVariantId for grandfathered pricing, so the lookup exists.

## Problem (from ticket `11746b62-8e6b-4e18-9c39-498ee12401d6`)
Customer Jessica Ollet tried to swap Amazing Coffee instant → K-Cups in the portal and it failed twice with appstle_error 400, with no path to self-serve; the swap silently never happened and required manual repair. Any Appstle-sub customer doing a portal swap can hit this.

## Phases
- ⏳ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the ticket scenario → confirm the fixed behavior, and that the ticket that surfaced it would now be handled correctly.

> Authored by the box Improve agent from ticket `11746b62-8e6b-4e18-9c39-498ee12401d6`. Commission the build from the Roadmap board (owner = cs).
