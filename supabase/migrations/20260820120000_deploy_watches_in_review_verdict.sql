-- reva-box-session-causal-rollback Phase 1 — add `in_review` to the deploy_watches.verdict CHECK.
--
-- Reva moves off the deterministic cron path onto a supervised box session (docs/brain/specs/
-- reva-box-session-causal-rollback.md). On a non-healthy verdict, `evaluateDueDeployWatches` now
-- enqueues a `kind='deploy-review'` agent_jobs row (Reva's Max session reads the merge_sha's diff and
-- decides revert|keep|escalate per candidate signal) and stamps the watch verdict `in_review` instead
-- of reverting/escalating directly. `in_review` is a NEW terminal-until-worker-applies state:
--
--  - The pending-window read (`deploy_watches_pending_window_idx`, partial on verdict='pending') already
--    excludes `in_review`, so a re-tick cannot re-open a watch mid-review — no index change needed.
--  - The Phase-3 worker (`applyBoxDeployReview`) claims on `verdict='in_review'` and stamps the final
--    verdict (`healthy` on 'keep', `regressed` on 'revert', `unsure` on 'escalate').
--
-- Mirrors the extend-a-status-enum pattern used by other agent lifecycles (agent_jobs.status is free
-- text; deploy_watches.verdict has a CHECK, so we drop-and-recreate the constraint).

alter table public.deploy_watches drop constraint if exists deploy_watches_verdict_check;

alter table public.deploy_watches
  add constraint deploy_watches_verdict_check
  check (verdict in ('pending', 'healthy', 'regressed', 'unsure', 'in_review'));

comment on column public.deploy_watches.verdict is
  'pending (default) | healthy | regressed | unsure | in_review. `in_review` is stamped by the cron on a non-healthy verdict when it enqueues a Reva deploy-review box-session job (reva-box-session-causal-rollback Phase 1); the pending-window index (partial on verdict=pending) naturally excludes it, so the cron doesn''t re-open a watch mid-review. The Phase-3 worker (applyBoxDeployReview) claims on verdict=in_review and stamps the final verdict (healthy on keep, regressed on revert, unsure on escalate).';
