# Crisis Tier 1 — Flavor Swap

First tier of the crisis campaign. Email-only. Sent automatically by [[../inngest/crisis-campaign]] for customers whose next billing falls within `lead_time_days` of an active OOS event.

DB row in [[../tables/journey_definitions]]: `slug='crisis-tier1-flavor-swap'`, `journey_type='custom'`, `trigger_intent='crisis_tier1'`.

See [[../lifecycles/crisis-campaign]] for the end-to-end tier sequencing.

## Trigger

- **trigger_intent**: `crisis_tier1` (system-issued, not from customer messages)
- **match_patterns**: empty (campaign-driven)
- **priority**: 10

## Channel

`email` only. Crisis communications need rich formatting + are inherently campaign-shaped, so other transports aren't supported.

## Pre-step: silent auto-swap

Before the customer ever sees the email:

1. [[../inngest/crisis-campaign]] finds the customer's sub matching `crisis_events.affected_variant_id`.
2. Swaps that line to `crisis_events.default_swap_variant_id` via [[../integrations/appstle]] subscription line-item mutation.
3. This ensures the next ship goes out even if the customer never engages.

`original_item` is preserved on [[../tables/crisis_customer_actions]] so we can restore later.

## Step

1. **Pick a flavor** — single-choice from `crisis_events.available_flavor_swaps` (e.g. Strawberry Lemonade, Tropical Punch, Citrus, etc.) + a "Keep Strawberry Lemonade, that's fine" option.

## On submit

If they picked a different flavor:

- Re-swap the line via [[../integrations/appstle]] to their chosen variant.
- Update [[../tables/crisis_customer_actions]]: `tier1_response='accepted_swap'`, `tier1_swapped_to={variantId, title}`.

If they kept the default:

- Same record: `tier1_response='accepted_swap'`, `tier1_swapped_to={default_swap variant}`.

If they reject ("not interested in switching"):

- `tier1_response='rejected'`. After `tier_wait_days`, [[crisis-tier2-product-swap]] fires.

## Pricing preservation

If the new variant is cheaper than the original, customer pays the lower price; if more expensive, we honor the original price via `preserved_base_price_cents`. Crisis swaps shouldn't be a pricing event — we caused the inconvenience.

## Outcomes

| Tag | When |
|---|---|
| `crisis` + `crisis:{event_id}` | Always |
| `crisis:test` | If the crisis is in test mode |
| Tier 1 outcome (not jo:*) | Tracked on [[../tables/crisis_customer_actions]].`tier1_response`, not on ticket tags |

Crisis tier outcomes don't use `jo:positive/negative/neutral` — they use the per-tier response columns on [[../tables/crisis_customer_actions]] for richer analytics.

## Step ticket status

`open` — ticket stays open across tiers.

## Files

| File | Purpose |
|---|---|
| `src/lib/crisis-journey-builder.ts` | Tier 1 / 2 / 3 builder |
| `src/lib/inngest/crisis-campaign.ts` | Daily campaign cron — finds eligible, advances tiers, auto-swaps |
| `src/lib/subscription-items.ts` | Appstle line-item swap |
| `src/lib/appstle.ts` | Appstle calls |
| `src/lib/email.ts` | Tier 1 email template |
| `src/lib/journey-launcher.ts` | Launcher |
| `src/app/journey/[token]/page.tsx` | Mini-site renderer |
| `src/app/api/journey/[token]/complete/route.ts` | Apply flavor + record |

## Related

[[../lifecycles/crisis-campaign]] · [[crisis-tier2-product-swap]] · [[crisis-tier3-pause-remove]] · [[../tables/crisis_events]] · [[../tables/crisis_customer_actions]] · [[../tables/subscriptions]] · [[../integrations/appstle]] · [[../inngest/crisis-campaign]]
