-- customers.email_canonical — indexed Gmail-canonical key for identity resolution
-- (identity-gmail-canonicalization-and-dot-insensitive-matching Phase 2).
--
-- The wedge: ticket 54f0f29e (Julie Metz) — support email `metz.julie323@gmail.com`
-- resolved to nothing because inbound-email ingest looked up by EXACT string,
-- while her real record is `metzjulie323@gmail.com`. Gmail ignores dots and
-- +tags, so both addresses resolve to the same real inbox — but every
-- self-serve tool saw them as distinct customers and Sol/June were handed the
-- empty shadow. Prevalence at the time this ships: 180 true dot/plus-variant
-- collision groups and 404 empty shadow records.
--
-- This migration is the **single source of truth** for the canonical key:
--   1. `email_canonical text NULL` on `public.customers` (defense-in-depth
--      populated by trigger; no call site can forget it and cause drift).
--   2. `canonicalize_email(text) → text` — an IMMUTABLE SQL function whose
--      behavior mirrors `canonicalizeEmail` in `src/lib/email-utils.ts` (the
--      unit-pinned helper). Kept in the DB so the ingest / matcher / a
--      hand-run repair script all agree on what "same inbox" means without
--      round-tripping through Node.
--   3. `customers_email_canonical_trigger` — BEFORE INSERT OR UPDATE OF
--      email — sets `NEW.email_canonical := public.canonicalize_email(NEW.email)`.
--      Every insert/upsert and every email-touching update stays in sync
--      automatically. No call site can drift.
--   4. `idx_customers_email_canonical (workspace_id, email_canonical)` — the
--      composite index the Phase-3 ingest attach + the Phase-4 matcher email
--      branch will read; matches the existing (workspace_id, email) shape.
--   5. An idempotent inline UPDATE backfills every existing row where
--      `email_canonical IS NULL`. The ship-time-backfill convention also
--      ships an idempotent `scripts/_backfill-customers-email-canonical.ts`
--      as a safety net (auto-ledgered by `detectAndEscalateShipTimeBackfills`),
--      so on a shipped repo the inline UPDATE + ledgered rerun are both safe.
--
-- Additive, idempotent, safe to re-apply — every DDL is `IF NOT EXISTS` and
-- every DML is `WHERE email_canonical IS NULL`. Auto-applied by the Control
-- Tower migration-drift reconciler on merge to main.

-- 1. Column.
alter table public.customers
  add column if not exists email_canonical text;

comment on column public.customers.email_canonical is
  'Gmail-canonical form of `email` — the shared identity key inbound ingest + account-matcher use to resolve dot/plus variants to the same inbox (identity-gmail-canonicalization-and-dot-insensitive-matching Phase 2). Populated automatically by `customers_email_canonical_trigger` on every insert/update of email; NEVER written by app code (single source of truth is `public.canonicalize_email`). NULL is possible only for a row whose `email` is itself NULL — every non-null email has a non-null canonical.';

-- 2. Canonicalizer. Mirrors src/lib/email-utils.ts:canonicalizeEmail.
--    - lowercase + trim always
--    - split on LAST @; malformed (no @, empty local, trailing @) → return trimmed+lowered as-is
--    - gmail.com / googlemail.com: strip all '.' from local, drop everything from first '+',
--      normalize domain to gmail.com
--    - every other domain: return `${localLower}@${domainLower}` unchanged
--    Marked IMMUTABLE so it can be used inside index expressions if we ever want a
--    functional index; today the stored column + trigger fill that role.
create or replace function public.canonicalize_email(email text)
returns text
language plpgsql
immutable
as $$
declare
  trimmed text;
  at_idx int;
  local_raw text;
  domain text;
  plus_idx int;
  local_no_plus text;
  local_no_dots text;
begin
  if email is null then
    return null;
  end if;
  trimmed := lower(btrim(email));
  if length(trimmed) = 0 then
    return trimmed;
  end if;
  at_idx := length(trimmed) - position('@' in reverse(trimmed)) + 1;
  -- position() returns 0 when '@' not found → at_idx becomes length(trimmed)+1; also guard trailing @.
  if position('@' in trimmed) = 0
     or at_idx <= 1
     or at_idx >= length(trimmed) then
    return trimmed;
  end if;
  local_raw := substring(trimmed from 1 for at_idx - 1);
  domain := substring(trimmed from at_idx + 1);
  if domain <> 'gmail.com' and domain <> 'googlemail.com' then
    return local_raw || '@' || domain;
  end if;
  plus_idx := position('+' in local_raw);
  if plus_idx > 0 then
    local_no_plus := substring(local_raw from 1 for plus_idx - 1);
  else
    local_no_plus := local_raw;
  end if;
  local_no_dots := replace(local_no_plus, '.', '');
  return local_no_dots || '@gmail.com';
end;
$$;

comment on function public.canonicalize_email(text) is
  'Mirrors canonicalizeEmail() in src/lib/email-utils.ts — the shared canonicalizer that lets two addresses resolving to the same real inbox compare equal. IMMUTABLE. Gmail-only dot/plus stripping; every other domain returns trimmed+lowered unchanged (dots are significant elsewhere).';

-- 3. Trigger — set email_canonical whenever email is written. Fires on any insert or on
--    any update where email actually changed, so a plain retention_score update never
--    re-runs the canonicalizer.
create or replace function public.customers_set_email_canonical()
returns trigger
language plpgsql
as $$
begin
  new.email_canonical := public.canonicalize_email(new.email);
  return new;
end;
$$;

drop trigger if exists customers_email_canonical_trigger on public.customers;
create trigger customers_email_canonical_trigger
  before insert or update of email on public.customers
  for each row
  execute function public.customers_set_email_canonical();

-- 4. Composite index — mirrors the (workspace_id, email) shape callers already use.
--    A partial index skips the 404-ish rows whose email itself is NULL.
create index if not exists idx_customers_email_canonical
  on public.customers (workspace_id, email_canonical)
  where email_canonical is not null;

-- 5. Inline backfill. Idempotent — a re-apply matches zero rows. Runs in one
--    transaction; on a spec'd table (customers is ~500k rows on Superfoods) this
--    is fast enough for a merge-time auto-apply. If a workspace ever grows to
--    the point where this update needs chunking, the parallel
--    scripts/_backfill-customers-email-canonical.ts script (chunked, resumable,
--    ledgered to data_op_runs by detectAndEscalateShipTimeBackfills) is the
--    fallback + safety net.
update public.customers
   set email_canonical = public.canonicalize_email(email)
 where email_canonical is null
   and email is not null;
