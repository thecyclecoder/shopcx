-- Widen account_usage_snapshots token counters int4 → int8. The Mac reporter's
-- ccusage cumulative totals (esp. cache_read_tokens with heavy prompt caching)
-- exceed integer max (2,147,483,647) — e.g. 2,423,700,738 → 22003 out-of-range.
-- Widening is loss-free and compatible with existing box-written int values.
alter table public.account_usage_snapshots
  alter column input_tokens          type bigint,
  alter column output_tokens         type bigint,
  alter column cache_creation_tokens type bigint,
  alter column cache_read_tokens     type bigint;
