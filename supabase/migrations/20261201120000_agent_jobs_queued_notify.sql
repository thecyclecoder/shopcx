-- Event-driven box claims (box-listen-notify-instant-claims). NOTIFY the channel `agent_job_queued`
-- whenever a job row becomes claimable, so the box worker can claim it INSTANTLY via a session-mode
-- LISTEN connection instead of waiting up to a full poll tick (POLL_MS, currently 30s). The poll loop
-- stays as the backstop (a NOTIFY is fire-and-forget: if the box is disconnected when it fires — restart,
-- net blip — it's missed, and the next poll sweep catches it) AND as the box's liveness heartbeat.
--
-- Fires on: INSERT of a queued row, a status transition INTO queued/queued_resume, or a claimed_at change
-- on a queued row (the build-gate cooldown clearing → the row becomes claimable again). It deliberately
-- does NOT fire on unrelated column updates to an already-queued row (e.g. a heartbeat write), so the
-- notify volume tracks genuine "a lane has new work" events, not write churn. Payload is the job `kind`
-- so the listener could target a lane; the box just uses it as a wake signal.
--
-- The transaction pooler (:6543) does not deliver LISTEN/NOTIFY — the listener connects via the session
-- pooler (:5432). See src/lib/pg-pool.ts startAgentJobQueuedListener.
create or replace function public.notify_agent_job_queued() returns trigger
language plpgsql as $$
begin
  if new.status in ('queued', 'queued_resume')
     and (tg_op = 'INSERT'
          or new.status is distinct from old.status
          or new.claimed_at is distinct from old.claimed_at) then
    perform pg_notify('agent_job_queued', coalesce(new.kind, ''));
  end if;
  return null;
end $$;

drop trigger if exists agent_job_queued_notify_trg on public.agent_jobs;
create trigger agent_job_queued_notify_trg
  after insert or update on public.agent_jobs
  for each row execute function public.notify_agent_job_queued();
