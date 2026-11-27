-- The daily returns-reconcile-sweep minted a new dashboard card per stranded return on every run
-- (no dedupe_key), leaving ~1,670 open cards for a few dozen returns. Keep the NEWEST open card per
-- (return_id, escalation type), stamp it with the dedupe_key the sweep now writes, and dismiss the
-- older duplicates. Idempotent: a second run finds no un-keyed duplicates.
with sweep as (
  select id,
         'return_sweep:' || coalesce(metadata->>'type', 'unknown') || ':' || coalesce(metadata->>'return_id', 'none') as key,
         row_number() over (
           partition by coalesce(metadata->>'type', 'unknown'), coalesce(metadata->>'return_id', 'none')
           order by created_at desc, id desc
         ) as rn
  from public.dashboard_notifications
  where dismissed = false
    and metadata->>'type' like 'return_sweep_%'
    and not (metadata ? 'dedupe_key')
)
update public.dashboard_notifications d
set dismissed = true
from sweep
where d.id = sweep.id and sweep.rn > 1;

with sweep as (
  select id,
         'return_sweep:' || coalesce(metadata->>'type', 'unknown') || ':' || coalesce(metadata->>'return_id', 'none') as key
  from public.dashboard_notifications
  where dismissed = false
    and metadata->>'type' like 'return_sweep_%'
    and not (metadata ? 'dedupe_key')
)
update public.dashboard_notifications d
set metadata = d.metadata || jsonb_build_object('dedupe_key', sweep.key)
from sweep
where d.id = sweep.id
  and not exists (
    select 1 from public.dashboard_notifications o
    where o.dismissed = false and o.metadata->>'dedupe_key' = sweep.key
  );
