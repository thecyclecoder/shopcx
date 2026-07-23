-- roadmap-box-broadcast — push the DevOps live surface (roadmap/pipeline page + box build page) to the
-- browser via Realtime BROADCAST instead of polling /api/roadmap/box + /api/roadmap/chat-session every
-- few seconds. Broadcast (not Postgres Changes) because Postgres Changes' per-row RLS (Walrus) is buggy —
-- see docs/brain/recipes/realtime-subscriptions.md.
--
-- Three tables feed the same per-workspace topic `box:<workspace_id>` (one topic → one client hook,
-- src/lib/use-box-live.ts):
--   1. agent_jobs        — build/plan/fold lanes, queue, session_checklist streaming, status flips.
--   2. roadmap_chats     — the Opus authoring chat's turn_status (AuthoringChat).
--   3. worker_heartbeats — the box's running_sha + liveness + lane usage (the box page's header). This is
--        the one that answers "which SHA is the box on / is it up?" — it updates every poll tick (~30s)
--        and on restart, and does NOT touch agent_jobs, so without its own trigger a SHA change on an idle
--        box would only surface on the client's slow backstop. It's a global singleton (no workspace_id),
--        so it broadcasts to the single-tenant workspace's topic via the same "oldest workspace" rule the
--        box worker itself uses (brain-roadmap.resolveDefaultWorkspaceId).
--
-- Payload is a minimal "something changed, refetch" signal — the pages re-hit their existing /api/*
-- endpoint for enriched data (same as the live-chat widget). realtime.send() (not broadcast_changes) so a
-- busy build's frequent writes don't ship fat rows. Private topic; authorized by the realtime.messages
-- `box_broadcast_read` policy. SEPARATE from agent_job_queued_notify_trg (pg_notify, wakes the box worker).

-- 1. agent_jobs → box:<workspace_id>
create or replace function public.broadcast_agent_job_change() returns trigger
language plpgsql security definer as $$
begin
  perform realtime.send(
    jsonb_build_object('src', 'agent_jobs', 'id', new.id, 'kind', new.kind, 'status', new.status, 'op', tg_op),
    'box_change', 'box:' || new.workspace_id::text, true);
  return null;
end $$;
drop trigger if exists agent_jobs_broadcast_trg on public.agent_jobs;
create trigger agent_jobs_broadcast_trg after insert or update on public.agent_jobs
  for each row execute function public.broadcast_agent_job_change();

-- 2. roadmap_chats → box:<workspace_id>
create or replace function public.broadcast_roadmap_chat_change() returns trigger
language plpgsql security definer as $$
begin
  perform realtime.send(
    jsonb_build_object('src', 'roadmap_chats', 'id', new.id, 'turn_status', new.turn_status, 'status', new.status, 'op', tg_op),
    'box_change', 'box:' || new.workspace_id::text, true);
  return null;
end $$;
drop trigger if exists roadmap_chats_broadcast_trg on public.roadmap_chats;
create trigger roadmap_chats_broadcast_trg after insert or update on public.roadmap_chats
  for each row execute function public.broadcast_roadmap_chat_change();

-- 3. worker_heartbeats → box:<single-tenant workspace> (singleton, no workspace_id).
create or replace function public.broadcast_worker_heartbeat_change() returns trigger
language plpgsql security definer as $$
declare ws uuid;
begin
  select id into ws from public.workspaces order by created_at asc limit 1;
  if ws is not null then
    perform realtime.send(
      jsonb_build_object('src', 'worker_heartbeats', 'running_sha', new.running_sha, 'status', new.status, 'op', tg_op),
      'box_change', 'box:' || ws::text, true);
  end if;
  return null;
end $$;
drop trigger if exists worker_heartbeats_broadcast_trg on public.worker_heartbeats;
create trigger worker_heartbeats_broadcast_trg after insert or update on public.worker_heartbeats
  for each row execute function public.broadcast_worker_heartbeat_change();

-- Authorize receiving on `box:<workspace_id>` for members of that workspace. Additive to existing
-- realtime.messages policies (permissive/OR'd). Text-compared so a malformed topic can't error.
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema='realtime' and table_name='messages') then
    if not exists (select 1 from pg_policies where schemaname='realtime' and tablename='messages' and policyname='box_broadcast_read') then
      create policy box_broadcast_read on realtime.messages
        for select using (
          (select realtime.topic()) like 'box:%'
          and substring((select realtime.topic()) from 5) in (
            select workspace_id::text from public.workspace_members where user_id = auth.uid()
          )
        );
    end if;
  end if;
end $$;
