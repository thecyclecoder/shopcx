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
- Keyset-paginates the workspace's SMS-subscribed customers and processes each `STEP_BATCH` (1000) page inside its own `step.run` (`page-N`). Inngest runs each step as a separate short HTTP invocation (completed steps replay from memo, so the cursor loop resumes exactly where it left off) — **so no single invocation can hit the Vercel maxDuration ceiling**, regardless of subscriber count.

> **Why fan-out (2026-06-14):** the prior single-invocation design processed all ~138K subscribers in one run, timed out at ~71K, and restarted from the lowest id each day — so the back half of the book never refreshed (stuck ~29 days stale, which is how the 2026-05-31 SUMMERFIT send went out on a 2026-05-16 snapshot). Splitting into per-workspace runs + step-per-page removes the timeout entirely. Manual escape hatch `scripts/refresh-customer-segments.ts` (no serverless limit) is unchanged.

> **PostgREST 1000-row cap — page-size invariant (2026-07-04 fix):** the Supabase/PostgREST server silently truncates `.select().limit(N)` to `max-rows = 1000` — a `.limit(2000)` returns at most 1000. `processBatch` (the per-page fetch) infers "done" from `batch.length < limit`, so any `STEP_BATCH > 1000` returns a 1000-row page that reads as short → cursor nulls → the loop breaks after **one page** and the back half of the book stays stale. The 2026-07 whole-book-coverage regression was exactly this: only ~1000 of ~138K subscribers refreshed per cron. **Invariant:** `STEP_BATCH` MUST be ≤ 1000 (currently 1000 = exact match; a full page then equals `limit` and the cursor advances; the natural terminator is `if (!idRows?.length)` on the next fetch). Mirrored in `scripts/refresh-customer-segments.ts`. If the max-rows cap is ever raised at the PostgREST layer, this invariant relaxes correspondingly.

## Coverage heartbeat + `segment-coverage` output assertion (Phase 2)

The cron's end-of-run heartbeat carries three fields in `produced`:

- `fanned_out` — # workspaces the cron sent a `segments/refresh-workspace` event to.
- `sms_subscribed_total` — global count of `sms_marketing_status='subscribed'` customers.
- `sms_subscribed_fresh_26h` — subset whose `segments_refreshed_at` is within 26h.
- `coverage_ratio` — `fresh / total` rounded to 4 decimals (or `null` on an empty book).

These snapshot the STATE BEFORE the fanout's workspace runs land (fanout is async — the runs kick off but haven't finished when the cron returns). The number that matters at monitor time is on the LIVE `customers` table, not the beat, so the tile probes state directly.

The [[../libraries/control-tower.md]] `segment-coverage` output assertion runs each monitor tick (~15 min): it head-counts SMS-subscribed customers globally + the fresh-cohort (within 26h) + the stale-tail (older than 48h or NULL), and flips the tile RED if **coverage < 95%** OR **any subscribed row is >48h stale**. Sample-guarded (<100 subscribers ⇒ skip) so an empty/tiny workspace can't false-fire. This is the alarm that would have caught the 2026-07 1000/138K state — a 0.7% coverage tile hard-red hours after the cron, not weeks later on a delivery post-mortem.

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
