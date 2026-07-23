-- realtime-demo-broadcast — push realtime_demo changes to the browser via Realtime BROADCAST instead of
-- Postgres Changes. Broadcast does NOT use logical replication / the supabase_realtime publication / per-
-- row RLS (Walrus) — a table trigger explicitly sends the change to a private Realtime topic, and the
-- browser subscribes to that topic. This sidesteps the open Supabase Postgres-Changes+RLS bug where
-- INSERT/UPDATE events are silently filtered (only DELETE leaks through). Verified end-to-end 2026-07-23.
--
-- Pattern (see docs/brain/recipes/realtime-subscriptions.md):
--   1. AFTER trigger → realtime.broadcast_changes(topic, event, op, table, schema, new, old)  (sends PRIVATE)
--   2. realtime.messages RLS policy authorizing SELECT (receive) on the topic
--   3. browser: supabase.channel(topic, { config: { private: true } }) + realtime.setAuth(jwt) + .on('broadcast')

create or replace function public.realtime_demo_broadcast() returns trigger
language plpgsql security definer as $$
begin
  perform realtime.broadcast_changes(
    'realtime_demo',      -- topic (the channel the browser subscribes to)
    'db_change',          -- event name the browser filters on
    tg_op,                -- INSERT | UPDATE | DELETE (payload.operation)
    tg_table_name,
    tg_table_schema,
    new,                  -- payload.record (null on DELETE)
    old                   -- payload.old_record (null on INSERT)
  );
  return null;
end $$;

drop trigger if exists realtime_demo_broadcast_trg on public.realtime_demo;
create trigger realtime_demo_broadcast_trg
  after insert or update or delete on public.realtime_demo
  for each row execute function public.realtime_demo_broadcast();

-- Authorize receiving broadcasts on the 'realtime_demo' topic. The topic name is the gate here (demo);
-- a real workspace-scoped view would additionally check membership against the topic/claims. Guarded so
-- a re-apply is idempotent. `realtime.messages` exists once the project's Realtime is provisioned.
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema='realtime' and table_name='messages') then
    if not exists (select 1 from pg_policies where schemaname='realtime' and tablename='messages' and policyname='realtime_demo_broadcast_read') then
      create policy realtime_demo_broadcast_read on realtime.messages
        for select using ((select realtime.topic()) = 'realtime_demo');
    end if;
  end if;
end $$;
