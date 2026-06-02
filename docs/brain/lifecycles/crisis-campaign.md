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

## Dunning intersection

[[../tables/dunning_cycles]] subs are included in eligibility — being in dunning doesn't exempt a sub from crisis outreach. The dunning flow continues in parallel; if the sub recovers payment AND accepts a crisis swap, both pipelines apply.

## Auto-fetch via orchestrator

When a customer messages in independently — e.g. "is Mixed Berry back yet?" — the Sonnet orchestrator's `get_crisis_status` tool surfaces the customer's crisis state ([[../tables/crisis_customer_actions]] + [[../tables/crisis_events]]). Sonnet then answers with context: "It's still on backorder — we expect restock by [date]. We've already swapped your next shipment to Strawberry Lemonade. Did you want to change to a different flavor instead?"

See [[../lifecycles/ai-multi-turn]] crisis rules.

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
| `src/app/api/workspaces/[id]/crisis/route.ts` | CRUD |

## Status / open work

**Shipped:** Crisis event activation, daily cron eligibility scanning, Tier 1/2/3 journeys with flavor/product swaps, pause/remove logic, auto-resume + auto-readd on resolution — all functional.

**Known gaps / not yet shipped:** None identified.

**Recent activity:**
- `12f954ff` docs/brain: lifecycles/ — 12 narrative pages tracing key flows end-to-end

**Open questions:** None.

## Related

[[ticket-lifecycle]] · [[cancel-flow]] · [[ai-multi-turn]] · [[../integrations/appstle]] · [[../integrations/resend]] · [[../tables/crisis_events]] · [[../tables/crisis_customer_actions]] · [[../tables/subscriptions]] · [[../inngest/crisis-campaign]] · [[../inngest/portal-auto-resume]] · [[../journeys]]
