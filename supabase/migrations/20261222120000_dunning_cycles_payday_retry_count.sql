-- dunning_cycles.payday_retry_count — enforce MAX_PAYDAY_RETRIES on the payday path.
--
-- The payday-retry cron reschedules with:
--     const futurePaydays = getNextPaydayDates(...).filter(d => d > now + 1h);
--     if (futurePaydays.length > 0) { schedule next; return; }
--     // "no more paydays" — exhausted
-- `getNextPaydayDates` returns the 1st, the 15th, every Friday and the last business
-- day, so it ALWAYS yields a future date. The exhausted branch is unreachable and the
-- cycle reschedules forever. `MAX_PAYDAY_RETRIES = 4` is only consulted in the separate
-- dunning-payment-failed flow, never in this cron.
--
-- Compounding it, the cron logged every attempt with a hardcoded `attemptNumber: 0`, so
-- even a count-based guard elsewhere (`attemptNumber > MAX_PAYDAY_RETRIES`) could never
-- fire: 0 > 4 is never true.
--
-- Measured on 2026-09-09 before the fix:
--   17,729 of 17,949 payday retries (98.8%) carried attempt_number = 0, across 733 subs
--   509 of 787 subs exceeded the documented 4-retry cap
--   384 subs over 20 retries · 86 over 50 · max 192 on ONE cycle (Apr 17 → Sep 4)
--   420 cycles still in status='retrying', earliest next_retry_at 2026-08-07
--
-- Sustained decline volume at that ratio is a card-network risk, not just noise.
--
-- ⭐ Deliberately NOT backfilled from payment_failures. Backfilling would push ~509
-- cycles past the cap on the next tick, and the exhaustion path sends a payment-recovery
-- email + posts a note + fires Slack per cycle — a 400+ customer email blast in one
-- batch. Starting every existing cycle at 0 bounds the runaway immediately (each gets at
-- most MAX_PAYDAY_RETRIES more attempts) and lets those cycles exhaust gradually on their
-- own payday cadence.
--
-- See docs/brain/lifecycles/dunning.md § Phase 3.

alter table public.dunning_cycles
  add column if not exists payday_retry_count integer not null default 0;

comment on column public.dunning_cycles.payday_retry_count is
  'Payday retries already attempted on this cycle. Capped at MAX_PAYDAY_RETRIES (4) by dunning-payday-retry-cron. Starts at 0 for pre-existing cycles by design — see the migration that added it.';
