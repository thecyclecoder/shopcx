# Portal removeLineItem: resolve by variantId when lineId isn't a real Appstle line ⏳

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `c61858db-8f9a-4076-9beb-75f51f1ff52d`

Make the portal removeLineItem handler robust when an Appstle subscription line is shown with no real Appstle line_id. Per docs/brain/lifecycles/customer-portal.md:42, transform-subscription sets a line's id to line_id||variant_id, so an Appstle line missing its line_id surfaces in the portal with id===variant_id. The portal posts {lineId: ln.id, variantId: ln.variantId} (src/app/portal/[slug]/_sections/SubscriptionDetailScreen.tsx:772), and for non-internal subs the handler always treats a present lineId as a SubscriptionLine GID (src/lib/portal/handlers/remove-line-item.ts:62-64), so it calls Appstle with gid://shopify/SubscriptionLine/<variantId> and gets an unrecoverable 'Couldn't find LineId' 400 (appstle_error). Fix: for Appstle subs, only treat lineId as a lineGid when it matches a real line_id on the resolved contract items; otherwise fall back to variantId resolution, which appstleRemoveLineItem already supports via a live contract fetch (src/lib/subscription-items.ts:155-189). Additionally, when the target variant is not present on the live contract at all, treat the removal as already-satisfied (idempotent success) and return a friendly 'item already removed' result instead of surfacing the raw Appstle GID error — so the portal self-serves and the ticket never escalates. Update the relevant brain pages (portal handlers + customer-portal lifecycle) in the same PR.

## Problem (from ticket `c61858db-8f9a-4076-9beb-75f51f1ff52d`)
Customer Bonnie Whitlock tried to remove Superfood Tabs (variant 42614433480877) 5 times from active sub/contract 29709598893; each call failed with appstle_error 400 'Couldn't find LineId=gid://shopify/SubscriptionLine/42614433480877' because the portal sent the variant id as the lineId (the line had no Appstle line_id) and the handler trusted it as a GID. The item was actually already off the contract, so the failures were both confusing to the customer and an unnecessary human escalation.

## Phases
- ⏳ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the ticket scenario → confirm the fixed behavior, and that the ticket that surfaced it would now be handled correctly.

> Authored by the box Improve agent from ticket `c61858db-8f9a-4076-9beb-75f51f1ff52d`. Commission the build from the Roadmap board (owner = cs).
