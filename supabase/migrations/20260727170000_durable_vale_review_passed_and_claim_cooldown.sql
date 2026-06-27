-- build-gate-durable-review-signal: fix the claim-time build gate's Vale-review leg.
--
-- THE BUG: the gate (scripts/builder-worker.ts evaluateClaimTimeBuildGate) blocked a build unless
-- `specs.vale_pass=true`. But `vale_pass` is a TRANSIENT Vale→Ada hand-off flag: Vale's PASS sets it, then
-- Ada's disposition (applyAdaDisposition / markSpecCardBackToReview) CONSUMES/clears it when the spec leaves
-- in_review. So by build-claim time a spec that genuinely passed review has vale_pass=null → the gate blocks
-- it forever (re-claims every poll tick). A spec authored directly as status='planned' (never in_review) also
-- has no vale_pass and no review path → same deadlock.
--
-- THE FIX (Option B — durable marker):
--  1) Add `specs.vale_review_passed_at timestamptz` — a PERSISTENT "this spec passed Vale review" stamp set
--     alongside vale_pass on a Vale PASS, and left INTACT by Ada's disposition (it is NOT consumed). A
--     re-author / needs_fix bounce (markSpecCardBackToReview) clears it so a materially-changed spec must be
--     re-reviewed. The gate reads THIS instead of the consumed vale_pass.
--  2) Backfill it for specs that already passed review but whose vale_pass was consumed: any spec that has
--     left in_review into a post-review state (planned / shipped / deferred / folded) AND has a recorded
--     spec_review_passed director_activity (Vale's PASS audit) is stamped with that activity time. This
--     un-deadlocks the live victims without re-running review. (A still-in_review spec with vale_pass=true
--     also gets stamped — it passed, it's just awaiting disposition.)
--  3) Add a `claimed_at`-based COOLDOWN to claim_agent_job: a gate-HELD build is re-queued with claimed_at
--     stamped to a FUTURE instant ("don't re-pick before T"); the claim RPC now skips a queued job whose
--     claimed_at is in the future, so a held build backs off instead of churning every poll tick. A normal
--     queued job (claimed_at null) is unaffected; a past claimed_at (e.g. a stale heartbeat) is also eligible.

-- ── 1) durable column ──────────────────────────────────────────────────────────
alter table public.specs add column if not exists vale_review_passed_at timestamptz;

comment on column public.specs.vale_review_passed_at is
  'Durable "this spec passed Vale spec-review" stamp (build-gate-durable-review-signal). Set on a Vale PASS '
  'alongside the transient vale_pass flag; UNLIKE vale_pass it is NOT consumed by Ada''s disposition, so it '
  'survives the spec leaving in_review. Cleared on a send-back / re-author (markSpecCardBackToReview) so a '
  'materially-changed spec must be re-reviewed. The claim-time build gate reads THIS as the review-passed '
  'signal, never the consumed vale_pass.';

-- ── 2) backfill the live deadlock victims ──────────────────────────────────────
-- (a) specs that still carry vale_pass=true (passed, not yet disposed) — stamp them now.
update public.specs s
   set vale_review_passed_at = coalesce(s.vale_review_passed_at, s.updated_at, now())
 where s.vale_pass = true
   and s.vale_review_passed_at is null;

-- (b) specs that left in_review into a post-review state but whose vale_pass was consumed — recover the PASS
--     time from the director_activity audit trail (Vale records a 'spec_review_passed' row on every PASS).
update public.specs s
   set vale_review_passed_at = da.passed_at
  from (
    select workspace_id, spec_slug, max(created_at) as passed_at
      from public.director_activity
     where action_kind = 'spec_review_passed'
     group by workspace_id, spec_slug
  ) da
 where da.workspace_id = s.workspace_id
   and da.spec_slug = s.slug
   and s.vale_review_passed_at is null
   and s.status in ('planned', 'shipped', 'deferred', 'folded', 'in_testing');

-- ── 3) claim cooldown: skip a queued job whose claimed_at is a FUTURE "hold-until" stamp ───────────────
-- Re-create the kind-aware claim with the future-claimed_at backoff. p_kinds semantics unchanged.
create or replace function public.claim_agent_job(p_kinds text[] default null)
returns public.agent_jobs
language plpgsql
as $$
declare
  job public.agent_jobs;
begin
  select * into job from public.agent_jobs
    where status in ('queued', 'queued_resume')
      and (p_kinds is null or kind = any(p_kinds))
      -- build-gate cooldown: a gate-held build is re-queued with claimed_at set to a future instant so it
      -- backs off; only claim it once that hold has elapsed. A null claimed_at (normal queued job) or a past
      -- one (stale heartbeat reclaim) is eligible.
      and (claimed_at is null or claimed_at <= now())
    order by created_at
    for update skip locked
    limit 1;
  if not found then
    return null;
  end if;
  update public.agent_jobs
    set status = 'building', claimed_at = now(), updated_at = now()
    where id = job.id
    returning * into job;
  return job;
end $$;
