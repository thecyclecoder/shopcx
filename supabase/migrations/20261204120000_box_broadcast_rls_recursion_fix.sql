-- roadmap-box-broadcast RLS recursion fix. The box_broadcast_read policy (20261203120000) did a raw
-- subquery on public.workspace_members to check membership. But workspace_members' OWN select policy is
-- SELF-REFERENTIAL — `workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id =
-- auth.uid())` — so any policy that joins to it recurses:
--   ERROR: infinite recursion detected in policy for relation "workspace_members"
-- In the Realtime broadcast authorization path that error is swallowed and the subscriber is silently
-- DENIED — the browser subscribes fine (green) but receives zero broadcasts. (The service-role test that
-- "passed" was a false positive: service_role bypasses RLS, so it never exercised the policy.)
--
-- Fix: a SECURITY DEFINER helper reads workspace_members as the function owner (bypassing its RLS →
-- no recursion). auth.uid() still resolves the caller's JWT sub inside a SECURITY DEFINER function, so
-- the membership check stays correct + workspace-scoped. This is the standard pattern for ANY RLS policy
-- that needs to consult workspace membership — reach for this helper, never a raw workspace_members join.

create or replace function public.user_can_read_box_topic(topic text)
  returns boolean language sql security definer stable
  set search_path = public as $$
    select topic like 'box:%' and exists (
      select 1 from public.workspace_members
      where user_id = auth.uid() and workspace_id::text = substring(topic from 5)
    );
  $$;
grant execute on function public.user_can_read_box_topic(text) to authenticated, anon;

do $$ begin
  if exists (select 1 from information_schema.tables where table_schema='realtime' and table_name='messages') then
    drop policy if exists box_broadcast_read on realtime.messages;
    create policy box_broadcast_read on realtime.messages
      for select using (public.user_can_read_box_topic((select realtime.topic())));
  end if;
end $$;
