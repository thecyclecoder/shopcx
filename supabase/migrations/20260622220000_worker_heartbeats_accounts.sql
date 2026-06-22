-- worker_heartbeats per-account Max load (box-multi-account-failover Phase 2): surface how each Max
-- account in the round-robin pool is burning its 5-hour quota — per-account in-flight load + capped
-- state, the healthy/all-capped flags, and a recent cap/failover event ring — so an "everything's
-- capped" state is visible on the box-health view + Control Tower box tile instead of silent.
-- See docs/brain/specs/box-multi-account-failover.md + docs/brain/tables/worker_heartbeats.md.

alter table public.worker_heartbeats
  -- { pool: [{ label, in_flight, capped, capped_until }], healthy, total, all_capped, soonest_reset, events: [{ at, type, account, detail }] }
  add column if not exists accounts jsonb not null default '{}'::jsonb;
