# Portal removeLineItem: resolve by variantId when lineId isn't a real Appstle line ✅

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `c61858db-8f9a-4076-9beb-75f51f1ff52d`

Make the portal removeLineItem handler robust when an Appstle subscription line is shown with no real Appstle line_id. Per docs/brain/lifecycles/customer-portal.md:42, transform-subscription sets a line's id to line_id||variant_id, so an Appstle line missing its line_id surfaces in the portal with id===variant_id. The portal posts {lineId: ln.id, variantId: ln.variantId} (src/app/portal/[slug]/_sections/SubscriptionDetailScreen.tsx:772), and for non-internal subs the handler always treats a present lineId as a SubscriptionLine GID (src/lib/portal/handlers/remove-line-item.ts:62-64), so it calls Appstle with gid://shopify/SubscriptionLine/<variantId> and gets an unrecoverable 'Couldn't find LineId' 400 (appstle_error). Fix: for Appstle subs, only treat lineId as a lineGid when it matches a real line_id on the resolved contract items; otherwise fall back to variantId resolution, which appstleRemoveLineItem already supports via a live contract fetch (src/lib/subscription-items.ts:155-189). Additionally, when the target variant is not present on the live contract at all, treat the removal as already-satisfied (idempotent success) and return a friendly 'item already removed' result instead of surfacing the raw Appstle GID error — so the portal self-serves and the ticket never escalates. Update the relevant brain pages (portal handlers + customer-portal lifecycle) in the same PR.

## Problem (from ticket `c61858db-8f9a-4076-9beb-75f51f1ff52d`)
Customer Bonnie Whitlock tried to remove Superfood Tabs (variant 42614433480877) 5 times from active sub/contract 29709598893; each call failed with appstle_error 400 'Couldn't find LineId=gid://shopify/SubscriptionLine/42614433480877' because the portal sent the variant id as the lineId (the line had no Appstle line_id) and the handler trusted it as a GID. The item was actually already off the contract, so the failures were both confusing to the customer and an unnecessary human escalation.

## Phases
- ✅ **P1 — implement the fix** — done. `src/lib/portal/handlers/remove-line-item.ts` now only treats `lineId` as a SubscriptionLine GID when it matches a real `line_id` on the resolved items (`isRealLineGid`), else falls back to `variantId` resolution. `src/lib/subscription-items.ts#appstleRemoveLineItem` returns `{ success: true, alreadyAbsent: true }` when a numeric variant isn't on the live contract (idempotent "already removed"); `subRemoveItem` + the handler thread the flag through (`jsonOk({ alreadyRemoved: true })`). Brain pages updated: [[../libraries/portal__handlers__remove-line-item]] + [[../lifecycles/customer-portal]]. `npx tsc --noEmit` clean.

## What landed
- `src/lib/portal/handlers/remove-line-item.ts` — `isRealLineGid` check + variant-id fallback for Appstle subs; surfaces `alreadyRemoved` on idempotent success.
- `src/lib/subscription-items.ts` — `appstleRemoveLineItem` returns `alreadyAbsent: true` for an absent numeric variant (title-based orchestrator calls keep the descriptive error); return types of `appstleRemoveLineItem` + `subRemoveItem` widened with `alreadyAbsent?`.
- `docs/brain/libraries/portal__handlers__remove-line-item.md`, `docs/brain/lifecycles/customer-portal.md` — documented the fix.

## Verification
- On the customer portal (Shopify extension or mini-site), open a sub with an **Appstle** line whose `line_id` is empty in `subscriptions.items` (so the portal shows `id === variant_id`) and the variant **is still on the live contract** → tap **Remove** → expect the item removed (no `appstle_error 400 "Couldn't find LineId"`), `subscriptions.items` resyncs without it, and `jsonOk` returns `{ alreadyRemoved: false }`.
- On the same portal, tap **Remove** for an Appstle line that is **already off the live Appstle contract** (stale DB row, `id === variant_id`) → expect `jsonOk({ ok: true, alreadyRemoved: true })`, a friendly "Item removed" in the UI, a `portal.items.removed` event with `already_absent: true`, and **no `portal-action-failed` ticket** created.
- Reproduce the exact ticket: Bonnie Whitlock, Superfood Tabs variant `42614433480877`, contract `29709598893` → expect **no** `appstle_error` and a self-served success instead of a human escalation.
- An Appstle line **with** a real `line_id` (normal case): tap **Remove** → expect it still removes via the precise `lineGid` path (unchanged behavior).
- Orchestrator/title path: call `appstleRemoveLineItem` with a non-numeric title not on the contract → expect the unchanged descriptive `Variant "…" not found on contract. Available variants: …` error (no idempotent masking).

> Authored by the box Improve agent from ticket `c61858db-8f9a-4076-9beb-75f51f1ff52d`. Commission the build from the Roadmap board (owner = cs).
