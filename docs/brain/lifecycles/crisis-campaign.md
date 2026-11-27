# Crisis campaign

Proactive retention campaign system for out-of-stock (or other crisis) situations. Automatically contacts affected subscribers with a tiered offer sequence before their next order ships, tracks responses, and handles auto-resume / re-add when the crisis resolves. This page traces the full lifecycle from "admin clicks activate" to "crisis resolved + customers restored."

See [[../lifecycles/crisis-campaign]] for the original design doc.

## Cast

- Trigger: admin activates a [[../tables/crisis_events]] row in `/dashboard/crisis/{id}`.
- Brain: [[../inngest/crisis-campaign]] daily cron at 8 AM Central.
- State: [[../tables/crisis_customer_actions]] (per-customer tier state).
- Subscription mutations: [[../integrations/appstle]] (swap variant, pause, remove line item).
- Journeys: three crisis journeys (Tier 1 flavor swap, Tier 2 product swap + coupon, Tier 3 pause/remove). See [[../journeys]].
- Tickets: one per affected customer.
- Comms: [[../integrations/resend]] per-tier emails.

## Phase 1 — admin configures the crisis

A workspace admin creates a [[../tables/crisis_events]] row at `/dashboard/crisis/new`:

- **Affected variant**: which Shopify variant is the problem (e.g. Mixed Berry Tabs).
- **Default swap variant**: where to silently auto-swap on Tier 1 send (typically the closest flavor — Strawberry Lemonade for Mixed Berry).
- **Available flavor swaps**: multi-select of variants the customer can pick at Tier 1.
- **Available product swaps**: multi-select of *different* products for Tier 2 (a bigger ask — "try our drink mix instead").
- **Tier 2 coupon**: Shopify coupon code (e.g. `STILLOUT20`) + percent (typically 20).
- **Expected restock date**: drives messaging tone.
- **Lead time days** (default 7): how many days before `next_billing_date` we send Tier 1.
- **Tier wait days** (default 3): days between tier escalations after rejection.

`status='draft'` until the admin flips to `active`. Tiers don't fire on draft crises.

## Phase 2 — daily campaign cron

[[../inngest/crisis-campaign]] fires every day at 8 AM Central. For each `active` crisis:

### Step 2a — find eligible subscriptions

```sql
SELECT subscription FROM subscriptions
WHERE workspace_id = crisis.workspace_id
  AND items JSONB contains crisis.affected_variant_id
  AND status IN ('active', 'paused-due-to-dunning')  -- includes in-dunning
  AND id NOT IN (SELECT subscription_id FROM crisis_customer_actions WHERE crisis_id = crisis.id)
  AND next_billing_date <= now() + crisis.lead_time_days
```

For each:

- Determine segment:
  - `berry_only` — the affected variant is the ONLY real item in the sub.
  - `berry_plus` — there are other items beyond the affected one. Shipping protection doesn't count as a real item.
- **Silently auto-swap** the affected line to `default_swap_variant_id` via [[../integrations/appstle]] subscription line-item mutation. This ensures the next ship will go through even if the customer ignores all our outreach.
- Insert [[../tables/crisis_customer_actions]] with `current_tier=1`, `segment`, `original_item` (so we can restore later).
- Create a ticket (channel=`email`) so all communications thread together.
- Fire the Tier 1 journey CTA via [[../integrations/resend]].

**Start Auto-Swap button (manual, current path).** The daily cron no longer swaps; the swap runs from the crisis page's Start Auto-Swap button (crisis must be `active`). `POST /api/workspaces/[id]/crisis/[crisisId]/auto-swap` works in batches: the page calls it with `cursor` until `done`. Each call scans active/paused subs by id, matches the affected item by Shopify variant id, its resolved UUID, or `affected_sku`, ENROLS a missing `crisis_customer_actions` row (`current_tier=0`, `tier1_sent_at` null, `original_item` = the affected line) and swaps via `subSwapVariant`, which carries the line's locked price across on both rails. A `$0` free line is re-applied after the swap (the swap only preserves positive locks). The cron then sends Tier 1 to enrolled rows once they are inside the lead window. The old "Honor grandfathered pricing" re-price (last order price ÷ 0.75) was removed on 2026-11-13: it could overwrite the price the swap had already preserved.

### Step 2b — advance existing rows

For rows where `current_tier=N` and `tierN_response='rejected'` and `tierN_sent_at + tier_wait_days <= now()`:

- If N=1 → send Tier 2 → `current_tier=2`.
- If N=2 → send Tier 3 → `current_tier=3`.
- If N=3 → execute fallback action (berry_only → launch cancel journey; berry_plus → remove the item permanently with `auto_readd=false`).

`current_tier=0` means not started — only Phase 2a applies.

## Phase 3 — Tier 1 (flavor swap)

The customer gets an email: "Mixed Berry is temporarily out of stock — we've swapped your next shipment to Strawberry Lemonade. Want to pick a different flavor instead?"

Mini-site shows:

- Single-choice list of `available_flavor_swaps` + "Keep Strawberry Lemonade, that's fine."
- The default swap is filtered out of the alternatives (it is already the "Keep" option). If no alternatives remain (a two-flavor product, e.g. Cocoa out leaves only Hazelnut), Tier 1 still renders, telling the customer the swap is done (no question) with Keep / reject. It only falls back to the "No active crisis found" info step when there is neither a default swap nor any alternative.

If they pick a flavor:

- Re-swap to their chosen variant via Appstle line-item mutation.
- Update [[../tables/crisis_customer_actions]]: `tier1_response='accepted_swap'`, `tier1_swapped_to={variantId, title}`.

If they reject ("not interested"):

- `tier1_response='rejected'`. Tier 2 will fire after `tier_wait_days`.

Crisis tags: `crisis`, `crisis:{id}`, `crisis:test` for staging.

## Phase 4 — Tier 2 (product swap + 20% coupon)

Three days later for rejections: "We hear you. How about trying [different product] instead? Here's 20% off."

Mini-site shows:

- Single-choice list of `available_product_swaps` (typically a different SKU entirely — e.g. powder instead of tabs).
- Quantity picker (1-4).
- "Not interested in changing products."

If they pick a product:

- Swap the line item to the new product via Appstle.
- Apply `tier2_coupon_code` via Appstle `subscription-contracts-apply-discount`.
- Update [[../tables/crisis_customer_actions]]: `tier2_response='accepted_swap'`, `tier2_swapped_to={...}`, `tier2_coupon_applied=true`.

If they reject:

- `tier2_response='rejected'`. Tier 3 fires after `tier_wait_days`.

## Phase 5 — Tier 3 (pause or remove)

Last-ditch retention. Behavior diverges by segment:

### berry_only

"We'll pause your subscription and automatically restart it when [variant] is back in stock."

- Pause: `appstleSubscriptionAction("pause")`. Set [[../tables/crisis_customer_actions]] `paused_at`, `auto_resume=true`. The pause is not scheduled to auto-resume — it stays paused until crisis resolution.
- "I'd rather cancel" → launch cancel journey (see [[cancel-flow]]).

### berry_plus

"We'll remove [variant] from your subscription and keep shipping your other items. We'll add it back when it's in stock."

- Remove the line item via Appstle. Sub keeps billing normally for remaining items.
- Set [[../tables/crisis_customer_actions]] `removed_item_at`, `auto_readd=true`.
- "I'd rather cancel" → launch cancel journey.

`tier3_response` records `accepted_pause` / `accepted_remove` / `rejected`.

## Phase 6 — crisis resolution

When the affected variant is back in stock, admin clicks **Resolve Crisis** at `/dashboard/crisis/{id}`. This triggers mass actions:

### Auto-resume paused subs

For rows where `auto_resume=true`:

- `appstleSubscriptionAction("resume")`.
- Update [[../tables/crisis_customer_actions]] `resolved_at`.
- Email customer: "Great news! [variant] is back. Your subscription has been restarted."

### Auto-readd removed items

For rows where `auto_readd=true`:

- Add the original variant back to the sub via Appstle line-item add.
- Email customer: "[variant] is back! We've added it back to your subscription."

### Optional revert for swapped customers

For rows where Tier 1 or Tier 2 swap was accepted:

- Optional follow-up journey: "Mixed Berry is back! Want us to swap you back?"
- Customer-driven, not automatic — they may have grown to like the new flavor.

### Auto swap-back for restart swaps

Rows with `auto_swap_back=true` (written when a customer RESTARTED a sub carrying the crisis flavor —
[[../libraries/crisis-restart-swap]]) are swapped back to `original_item` automatically on Resolve,
because the restart page promised it. Compare-and-set on the live sub items; failures block the
resolve unless `force_resolve`.

Flip [[../tables/crisis_events]] `status='resolved'`.

## Phase 7 — analytics

The detail page at `/dashboard/crisis/{id}` shows live stats:

- Total affected.
- Per-tier: sent / accepted swap / rejected.
- Final outcomes: paused / removed / cancelled.

Drives the "did this campaign work?" retrospective. Patterns inform tier-wait tuning + coupon-percent calibration.

## First-touch + tagging

All crisis tickets get `crisis` + `crisis:{id}`. Test tickets get `crisis:test`. Tier 1 send marks `touched` + `ft:crisis`. Subsequent tier sends don't replace first-touch.

## Pricing preservation

When a crisis swap happens, the original `preserved_base_price_cents` is recorded on [[../tables/crisis_customer_actions]]. If the new variant is cheaper, the customer pays the lower price; if more expensive, we honor the original price. The Tier 2 coupon is added on top.

This matters because crisis swaps shouldn't be a pricing event for the customer — we caused the inconvenience, they shouldn't pay more for it.

**Enforced by the SDK, not the caller (2026-07-30 crisis fix).** The rule above used to be honored only when the caller remembered to preserve. On 2026-07-30 a crisis swap reset the line price of 286 subscriptions to catalog, 8 renewals billed at the reset price, and $245.40 was refunded before anyone noticed — nobody wrote a bad line of code, `subSwapVariant` simply didn't carry the price across, and `callReplaceVariants` reported success on a contract at catalog. [[../libraries/subscription-items|subSwapVariant]] (fronted by [[../libraries/commerce__subscription|subscriptionSwapVariant]]) now: (1) captures the outgoing line's realized per-unit price BEFORE the replace on both rails (Appstle: live `contract-external`; internal: [[../libraries/pricing|resolveSubscriptionPricing]]); (2) refuses the swap on any locked line whose realized can't be read — a swap that can't guarantee the price must not happen unattended; (3) carries the captured realized forward — Appstle: `subUpdateLineItemPrice(base = round(captured / (1 − sns)))`; internal: verbatim `price_cents` copies directly, else `price_override_cents` back-solved through the engine so quantity breaks are honored (the 2026-07-30 cleanup found qty-4 lines that needed base $59.01 to price at $38.95 — the flat-sns formula gave $51.93); (4) POST-SWAP re-reads the observed realized on both rails and asserts via [[../libraries/swap-price-assertion|assertSwapDidNotRaise]] (2¢ tolerance) — a mispricing that would have shipped silently is now returned as `success: false` naming the contract + expected + observed. Callers pass no new arguments. Spec: [[../specs/swap-variant-preserves-the-line-price]].

## Dunning intersection

[[../tables/dunning_cycles]] subs are included in eligibility — being in dunning doesn't exempt a sub from crisis outreach. The dunning flow continues in parallel; if the sub recovers payment AND accepts a crisis swap, both pipelines apply.

## Auto-fetch via orchestrator

When a customer messages in independently — e.g. "is Mixed Berry back yet?" — the Sonnet orchestrator's `get_crisis_status` tool surfaces the customer's crisis state ([[../tables/crisis_customer_actions]] + [[../tables/crisis_events]]). Sonnet then answers with context: "It's still on backorder — we expect restock by [date]. We've already swapped your next shipment to Strawberry Lemonade. Did you want to change to a different flavor instead?"

See [[../lifecycles/ai-multi-turn]] crisis rules.

## Waiting for restock (customer declined the substitute)

A customer can refuse the substitute flavor and ask to wait for their original flavor to come back. The `crisis_enroll` direct action ([[../libraries/action-executor]]) accepts `hold_for_restock=true` for exactly this case — it records `tier1_response='rejected'` (NOT `'accepted_swap'`) and sets [[../tables/crisis_customer_actions]].`hold_for_restock=true`, keeping `auto_readd=true`. If the sub is already enrolled, the call updates `hold_for_restock=true` on the existing row instead of returning early (so a prior `accepted_swap` enrollment can be corrected once the customer speaks up). The orchestrator's `get_crisis_status` guidance tells Sonnet to use this path whenever the customer says they don't want the substitute and will wait.

Why it matters: without this flag every later automation reads the customer as having accepted the swap. The restart swap ([[../libraries/crisis-restart-swap]]) is the concrete hazard — it would otherwise swap such a customer to the substitute and charge them on restart (ground truth: Kristina, sub 2241b7a5, Cocoa crisis 99a58332, who was swapped to Hazelnut and billed, then cancelled). Spec `crisis-restart-swap-respects-wait-for-restock`.

On restart (portal or win-back journey), `crisisSwapsForItems` now takes the subscription id and reads that row: `customerIsWaitingForRestock(row)` (true for `hold_for_restock`, a `rejected` tier 1/2 response, or a tier 3 `accepted_pause`/`accepted_remove`) turns the line's plan into a **hold** instead of a swap. `applyCrisisSwapsAfterRestart` then pauses the whole sub (no auto-resume date) and stamps the existing row `paused_at`, `auto_resume=true`, so crisis Resolve resumes it with the original flavor — the customer is never charged for the substitute. A pre-existing row on a plain swap is only patched on `tier1_swapped_to`/`auto_swap_back`/`updated_at`, never wholesale-overwritten. The restart page (`crisisNotice`) and the internal note (`crisisSwapNote`) both render the hold copy.

## Restock promise for a customer with NO subscription

The flow above restores **subscribers** on resolve — resume, re-add, swap-back — but all of it keys off a `crisis_customer_actions` row tied to a subscription. A **one-time buyer** with no subscription that support promised ("we'll send your Cocoa when it's back") had nowhere structured to live; the promise sat only in a snoozed ticket a human had to remember (ground truth: Peggy, customer `0897b4e5`; CEO 2026-11-27 spec).

**Phase 1 (record — shipped):** the `promise_restock_replacement` direct action ([[../libraries/action-executor]]) records the promise into [[../tables/replacements]] with `status='awaiting_restock'`, `crisis_id` set, `reason='crisis_restock_promise'`, and the item in `items` — **no Shopify order is created**. It resolves the crisis by explicit `crisis_id` or the active [[../tables/crisis_events]] row whose `affected_variant_id` matches, enforces the per-variant cap (`REPLACEMENT_MAX_UNITS_PER_VARIANT`), and writes an internal ticket note. The orchestrator is taught to reach for it (over `create_replacement_order`, which ships now) when the item is out of stock and the customer is waiting for restock, and the customer-data context surfaces `awaiting_restock` rows so the AI can answer "when will my Cocoa ship?". Spec: [[../specs/crisis-resolve-ships-promised-restock-replacements]].

**Phase 2 (ship on resolve — shipped):** after the crisis status flips to `resolved`, the resolve route calls [[../libraries/crisis-restock-fulfillment]] `shipRestockPromises(admin, workspaceId, crisisId)`. It selects every `awaiting_restock` [[../tables/replacements]] row for the crisis, **compare-and-sets each off `awaiting_restock` → `pending` BEFORE any Shopify call** (so a double-click or concurrent Resolve can't ship twice), then ships it through [[../libraries/replacement-order]] `createReplacementOrder` REUSING the promise row via `existingReplacementId` (one row per promise, record-first intact). The customer gets the normal Shopify order confirmation and the ticket gets an internal note `Crisis resolved: restock replacement {order name} created ({items}).`. **A restock failure does NOT un-resolve the crisis** — the row is marked `failed`, the ticket reopened, and a high-severity `fulfillment_alert` [[../tables/dashboard_notifications]] row raised for a human to ship it by hand. The resolve response carries `restock_replacements_created` / `restock_replacements_failed` counts, and the GET crisis summary carries `restock_promises_pending`.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/inngest/crisis-campaign.ts` | Daily cron — find eligible, advance tiers, send |
| `src/lib/crisis-journey-builder.ts` | Per-tier journey step builder |
| `src/lib/subscription-items.ts` | Appstle line item swap / add / remove |
| `src/lib/subscription-add-items.ts` | Add items helper |
| `src/lib/appstle.ts` | All Appstle calls |
| `src/lib/email.ts` | Tier 1 / 2 / 3 / resolution emails |
| `src/lib/journey-launcher.ts` | Launch crisis journeys |
| `src/lib/ticket-tags.ts` | crisis tags |
| `src/lib/journey-delivery.ts` | Channel-aware send |
| `src/app/dashboard/crisis/page.tsx` | List view |
| `src/app/dashboard/crisis/new/page.tsx` | Create / edit |
| `src/app/dashboard/crisis/[id]/page.tsx` | Detail + stats + resolve button |
| `src/app/api/workspaces/[id]/crisis/[crisisId]/resolve/route.ts` | Mass resolution actions |
| `src/app/api/workspaces/[id]/crisis/[crisisId]/route.ts` | Resolve POST — subs side-effects + restock-promise shipping |
| `src/lib/crisis-restock-fulfillment.ts` | `shipRestockPromises` — ships `awaiting_restock` promises on resolve |
| `src/lib/replacement-order.ts` | `createReplacementOrder` (+ `existingReplacementId` row reuse) |
| `src/app/api/workspaces/[id]/crisis/route.ts` | CRUD |

## Status / open work

**Shipped:** Crisis event activation, daily cron eligibility scanning, Tier 1/2/3 journeys with flavor/product swaps, pause/remove logic, auto-resume + auto-readd on resolution — all functional.

**Shipped 2026-11-22:** restarts (portal + win-back journey) swap crisis flavors to the default on the way back in and enrol `auto_swap_back` rows ([[../libraries/crisis-restart-swap]]).

**Shipped (restock-promise spec):** Phase 1 — `promise_restock_replacement` records a `status='awaiting_restock'` [[../tables/replacements]] row against the crisis for a subscription-less customer. Phase 2 — crisis Resolve ships those rows through `createReplacementOrder` (row reuse via `existingReplacementId`, compare-and-set guard, failure → row `failed` + ticket reopen + `fulfillment_alert`) via [[../libraries/crisis-restock-fulfillment]] `shipRestockPromises`. See "Restock promise for a customer with NO subscription" above.

**Known gaps / not yet shipped:** no "your flavor is back" email on swap-back; stock outside a crisis row is invisible (product_variants has no inventory signal).

**Recent activity:**
- `12f954ff` docs/brain: lifecycles/ — 12 narrative pages tracing key flows end-to-end

**Open questions:** None.

## Related

[[ticket-lifecycle]] · [[cancel-flow]] · [[ai-multi-turn]] · [[../integrations/appstle]] · [[../integrations/resend]] · [[../tables/crisis_events]] · [[../tables/crisis_customer_actions]] · [[../tables/subscriptions]] · [[../inngest/crisis-campaign]] · [[../inngest/portal-auto-resume]] · [[../journeys]] · [[../libraries/crisis-substitution]]
