# inngest/refresh-customer-segments

Recomputes `customers.segments` array for archetype-driven SMS targeting. See PERPETUAL-CAMPAIGNS-SPEC.md.

**File:** `src/lib/inngest/refresh-customer-segments.ts`

## Functions

Two functions, fan-out architecture (the cron only dispatches; the per-workspace function does the work):

### `refresh-customer-segments-cron`
- **Trigger:** cron `0 11 * * *` (11:00 UTC = 6 AM Central, before the marketing-text send-tick resolves the day's audiences)
- **Retries:** 2 · **Concurrency:** `[{ limit: 1 }]`
- Sends one `segments/refresh-workspace` event per workspace. That's all — trivial + fast.

### `refresh-workspace-segments`
- **Trigger:** event `segments/refresh-workspace` · **Retries:** 2 · **Concurrency:** `[{ limit: 4 }]`
- Keyset-paginates the workspace's SMS-subscribed customers and processes each `STEP_BATCH` (2000) page inside its own `step.run` (`page-N`). Inngest runs each step as a separate short HTTP invocation (completed steps replay from memo, so the cursor loop resumes exactly where it left off) — **so no single invocation can hit the Vercel maxDuration ceiling**, regardless of subscriber count.

> **Why fan-out (2026-06-14):** the prior single-invocation design processed all ~138K subscribers in one run, timed out at ~71K, and restarted from the lowest id each day — so the back half of the book never refreshed (stuck ~29 days stale, which is how the 2026-05-31 SUMMERFIT send went out on a 2026-05-16 snapshot). Splitting into per-workspace runs + step-per-page removes the timeout entirely. Manual escape hatch `scripts/refresh-customer-segments.ts` (no serverless limit) is unchanged.

## Segments produced

The function **replaces** the whole `customers.segments` array each run (so any tag must be (re)derived here — a hand-added tag is wiped on the next run). Archetype (mutually exclusive, order-cadence based): `cold` · `single_order` · `just_ordered` · `cycle_hitter` · `lapsed` · `deep_lapsed`. Additive flags: `engaged` (orders ≥1 + recent email-click/ATC/checkout/2× product-view), `active_sub` (any `status='active'` subscription), `storefront_signup` (customer id appears in [[../tables/storefront_leads]] — captured via the new storefront's signup surfaces; origin attribute, not time-decaying; lets SMS target net-new signups instead of the huge `cold` pool, since a no-order storefront signup is otherwise just `cold`). The manual escape hatch `scripts/refresh-customer-segments.ts` mirrors this logic (default scope = SMS-subscribed; `--all` = everyone).

## Downstream events sent

- `segments/refresh-workspace` (cron → per-workspace function; one per workspace)

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
