# inngest/refresh-customer-segments

Recomputes `customers.segments` array for archetype-driven SMS targeting. See PERPETUAL-CAMPAIGNS-SPEC.md.

**File:** `src/lib/inngest/refresh-customer-segments.ts`

## Functions

Two functions, fan-out architecture (the cron only dispatches; the per-workspace function does the work):

### `refresh-customer-segments-cron`
- **Trigger:** cron `0 11 * * *` (11:00 UTC = 6 AM Central, before the marketing-text send-tick + the sms-marketing agent resolve the day's audiences)
- **Retries:** 2 · **Concurrency:** `[{ limit: 1 }]`
- Sends one `segments/refresh-workspace` event per workspace, then probes coverage + heartbeats. That's all — trivial + fast.

### `refresh-workspace-segments`
- **Trigger:** event `segments/refresh-workspace` · **Retries:** 2 · **Concurrency:** `[{ limit: 4 }]`
- **One `.rpc()` call** to the set-based `public.refresh_customer_segments(workspace_id, all)` SQL function (migration `20260704160000`). The whole workspace recomputes inside Postgres in a single short invocation — no pagination, no per-row writes, no timeout risk.

> **Set-based rewrite (2026-07-04) — the ~3-hours-→-~1-minute fix.** The refresh used to be a per-customer read/compute/write loop: for each ~500-customer batch it chunk-read orders/subs/leads/events, computed segments in JS, then issued **one `UPDATE … WHERE id=$1` per customer** — ~138K individual PostgREST round-trips, ~3 HOURS wall-clock, far too slow to run daily. Worse, the chunked `.in(100 ids)` reads hit the same **PostgREST 1000-row cap** and could silently truncate a heavy customer's orders/events → wrong segments. Both are gone: `refresh_customer_segments()` computes every segment via aggregate CTEs (order count/first/last → reorder ratio where `meanGap=(last−first)/(n−1)` telescopes to a pure aggregate; engagement via `count(*) filter (…)`; active-sub/lead existence joins) in ONE `UPDATE … FROM (…)`. **138K customers in ~1 min (0.3s compute + the row writes), exact, validated byte-identical to the old `computeSegments()` on a 400-customer sample.** This also retires the earlier keyset-pagination whole-book-coverage bug (the 2026-07 1000/138K stale-book regression) — there is no pagination left to get wrong.

> **The SQL function `public.refresh_customer_segments(p_workspace_id uuid, p_all boolean)`** is the single source of the segment logic; both the cron and the manual escape hatch call it. `p_all=false` = SMS-subscribed scope (campaign targeting); `p_all=true` = everyone in the workspace. Returns the updated row count.

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
