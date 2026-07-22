-- Skeleton wireframe: replace the invalid subquery-CHECK with a shape-validation trigger.
--
-- Postgres forbids a subquery inside a CHECK constraint ("cannot use subquery
-- in check constraint"), so the original ALTER TABLE in
-- 20261124120000_creative_skeletons_wireframe.sql failed on apply — the columns
-- only exist today because they were applied manually column-only on 2026-07-22,
-- and there is NO shape validation on the elements array. This migration:
--
--   1. Re-declares the three columns (elements, product_presentation, punchiness)
--      idempotently via `add column if not exists`, so a fresh DB gets them via
--      this migration too (the original file stays in the tree unchanged — a
--      previously-applied broken migration is not re-attempted by the drift
--      reconciler).
--   2. Creates a `public.creative_skeletons_check_elements_shape` plpgsql
--      function that walks NEW.elements and raises on any malformed element:
--        - each element must be a jsonb OBJECT
--        - it must carry a whitelisted zone (header|hero|body|footer|cta)
--        - it must carry a whitelisted role
--          (hook|mechanism|proof|offer|risk_reversal|social_proof|price)
--        - `prominence` must be a jsonb number in [0, 1]
--      NULL elements is accepted (the legacy shape) — only a non-null array is
--      validated. A non-array elements is rejected.
--   3. Attaches the function as a BEFORE INSERT OR UPDATE trigger on
--      public.creative_skeletons. Modeled on the customers_email_canonical
--      trigger in 20261104120000_customers_email_canonical.sql.
--
-- Does NOT re-add the subquery CHECK — a trigger is the correct home for this
-- validation (Postgres constraint checks can only reference the row itself).
-- Additive + idempotent: safe to re-apply.  RLS unchanged.
--
-- See docs/brain/specs/creative-skeleton-wireframe-extractor-and-backfill-actually-built.md
-- Phase 1.

-- 1. Columns (idempotent — no-op when the manual 2026-07-22 apply already added them).
alter table public.creative_skeletons
  add column if not exists elements jsonb,
  add column if not exists product_presentation text[] not null default '{}',
  add column if not exists punchiness text[] not null default '{}';

-- 2. Shape-validation function. Walks NEW.elements and raises on the first
--    malformed element. Kept in plpgsql so the whitelists are visible in the
--    migration diff (a constraint-generator can grep them).
create or replace function public.creative_skeletons_check_elements_shape()
returns trigger
language plpgsql
as $$
declare
  elem jsonb;
  z text;
  r text;
  p_type text;
  p_num numeric;
begin
  if new.elements is null then
    return new;
  end if;

  if jsonb_typeof(new.elements) <> 'array' then
    raise exception 'creative_skeletons.elements must be a jsonb array (got %)',
      jsonb_typeof(new.elements)
      using errcode = '22023';
  end if;

  for elem in select value from jsonb_array_elements(new.elements) as t(value)
  loop
    if jsonb_typeof(elem) <> 'object' then
      raise exception 'creative_skeletons.elements element must be a jsonb object (got %): %',
        jsonb_typeof(elem), elem
        using errcode = '22023';
    end if;

    if not (elem ? 'zone' and elem ? 'role' and elem ? 'prominence') then
      raise exception 'creative_skeletons.elements element missing required key (zone/role/prominence): %', elem
        using errcode = '22023';
    end if;

    z := elem ->> 'zone';
    if z not in ('header','hero','body','footer','cta') then
      raise exception 'creative_skeletons.elements element has invalid zone %: %', z, elem
        using errcode = '22023';
    end if;

    r := elem ->> 'role';
    if r not in ('hook','mechanism','proof','offer','risk_reversal','social_proof','price') then
      raise exception 'creative_skeletons.elements element has invalid role %: %', r, elem
        using errcode = '22023';
    end if;

    p_type := jsonb_typeof(elem -> 'prominence');
    if p_type <> 'number' then
      raise exception 'creative_skeletons.elements element prominence must be a number (got %): %', p_type, elem
        using errcode = '22023';
    end if;

    p_num := (elem ->> 'prominence')::numeric;
    if p_num < 0 or p_num > 1 then
      raise exception 'creative_skeletons.elements element prominence must be in [0,1] (got %): %', p_num, elem
        using errcode = '22023';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.creative_skeletons_check_elements_shape() is
  'BEFORE INSERT/UPDATE trigger fn on creative_skeletons — validates the elements array shape (zone/role/prominence whitelists + [0,1] prominence). Replaces the invalid subquery-in-CHECK constraint from 20261124120000_creative_skeletons_wireframe.sql, which Postgres rejects. See docs/brain/specs/creative-skeleton-wireframe-extractor-and-backfill-actually-built.md Phase 1.';

-- 3. Trigger. Fires on every insert and every update (elements can change on
--    either), running the row-level shape check.
drop trigger if exists creative_skeletons_elements_shape_trigger on public.creative_skeletons;
create trigger creative_skeletons_elements_shape_trigger
  before insert or update on public.creative_skeletons
  for each row
  execute function public.creative_skeletons_check_elements_shape();
