-- ad_review_feedback — persisted CEO manual-review feedback packets on a finished ad.
-- Storage for the ceo-manual-ad-review-inline-per-element-feedback-routed-to-dahlia-max-render
-- Phase 1: the ad detail page's annotation UI flips read-only into a per-element comment mode
-- (4 render formats + 5 copy variations + canonical copy + Max grade), and Submit assembles a
-- structured packet of only the non-empty comments. Each packet entry carries the exact target
-- (target_kind + format/framework/variant key) so Phase 2's dispatcher can route surgically
-- (copy->Dahlia revise, image->render regenerate, max->Max re-QA) instead of bouncing a blurry
-- whole-ad rewrite.
--
-- One row per submit. `packet` is the full typed AdReviewFeedbackPacket (defined in
-- [[../../src/lib/ads/ad-review-feedback.ts]]) — jsonb so a new target-kind lands without a
-- migration; the .ts parser pins the required shape and the SDK is the writer chokepoint.
--
-- `status` is the Phase-2 lifecycle marker (queued -> processing -> done); Phase 1 always
-- writes `queued`. Additive + idempotent (CREATE TABLE IF NOT EXISTS, standard RLS bootstrap).
create table if not exists public.ad_review_feedback (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  ad_campaign_id      uuid not null references public.ad_campaigns(id) on delete cascade,
  -- Full typed AdReviewFeedbackPacket — every non-empty comment box the reviewer filled in,
  -- each tagged with its target ({targetKind, format|framework|variant, comment}). Empty
  -- boxes are omitted at build time by the SDK, so this jsonb is a compact record of only
  -- the surgical corrections the reviewer wanted. See [[../../src/lib/ads/ad-review-feedback.ts]]
  -- for the shape; the SDK validates before insert.
  packet              jsonb not null,
  -- Phase 2 lifecycle marker. Phase 1 writes 'queued' on every insert; Phase 2's dispatcher
  -- flips queued -> processing on start, then processing -> done on the final Max re-QA
  -- landing back in the bin. CHECK bounds the enum so a stray write can't degrade the column.
  status              text not null default 'queued'
                        check (status in ('queued','processing','done','failed')),
  -- The workspace member who submitted the packet (auth.users.id). Nullable so a Phase-2
  -- system-triggered re-submit (e.g. a webhook) doesn't need a stub user.
  created_by          uuid,
  created_at          timestamptz not null default now()
);

-- Per-campaign read: newest packet first (the ad detail page's "recent feedback" reader).
create index if not exists ad_review_feedback_campaign_idx
  on public.ad_review_feedback (ad_campaign_id, created_at desc);
-- Phase-2 dispatcher's queued-work read (workspace-scoped, oldest queued first so FIFO holds).
create index if not exists ad_review_feedback_workspace_status_idx
  on public.ad_review_feedback (workspace_id, status, created_at asc);

alter table public.ad_review_feedback enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='ad_review_feedback' and policyname='ad_review_feedback_service_all') then
    create policy ad_review_feedback_service_all on public.ad_review_feedback for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='ad_review_feedback' and policyname='ad_review_feedback_member_select') then
    create policy ad_review_feedback_member_select on public.ad_review_feedback for select to authenticated
      using (exists (select 1 from public.workspace_members m where m.workspace_id = ad_review_feedback.workspace_id and m.user_id = auth.uid()));
  end if;
end $$;

comment on table public.ad_review_feedback is
  'CEO manual-review feedback packets on a finished ad (ceo-manual-ad-review-inline-per-element-feedback-routed-to-dahlia-max-render Phase 1). One row per Submit; packet jsonb carries per-element {targetKind, key, comment} entries so Phase 2 can dispatch surgical edits (copy->Dahlia revise, image->render regenerate, max->Max re-QA) rather than a whole-ad rewrite. Writes go through insertAdReviewFeedback in src/lib/ads/ad-review-feedback.ts.';
