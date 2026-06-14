# inngest/refresh-customer-segments

Recomputes `customers.segments` array for archetype-driven SMS targeting. See PERPETUAL-CAMPAIGNS-SPEC.md.

**File:** `src/lib/inngest/refresh-customer-segments.ts`

## Functions

### `refresh-customer-segments-cron`
- **Trigger:** cron `0 11 * * *`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## Segments produced

The function **replaces** the whole `customers.segments` array each run (so any tag must be (re)derived here — a hand-added tag is wiped on the next run). Archetype (mutually exclusive, order-cadence based): `cold` · `single_order` · `just_ordered` · `cycle_hitter` · `lapsed` · `deep_lapsed`. Additive flags: `engaged` (orders ≥1 + recent email-click/ATC/checkout/2× product-view), `active_sub` (any `status='active'` subscription), `storefront_signup` (customer id appears in [[../tables/storefront_leads]] — captured via the new storefront's signup surfaces; origin attribute, not time-decaying; lets SMS target net-new signups instead of the huge `cold` pool, since a no-order storefront signup is otherwise just `cold`). The manual escape hatch `scripts/refresh-customer-segments.ts` mirrors this logic (default scope = SMS-subscribed; `--all` = everyone).

## Downstream events sent

_None._

## Tables written

- [[../tables/customers]]

## Tables read (not written)

- [[../tables/orders]]
- [[../tables/profile_events]]
- [[../tables/subscriptions]]
- [[../tables/storefront_leads]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
