-- ads-supervisor-digest-toggle: a per-workspace off switch for the ads-supervisor drift digest that
-- Max posts to #director-growth-max after each 3h supervisory pass over Bianca + Dahlia (e.g. "3 drift
-- issue(s) … Dahlia's ready-to-test bin is thin (0/4)"). Sibling of media_buyer_digest_enabled. Default
-- TRUE preserves behavior for every other tenant; the founder set it FALSE for Superfoods to silence the
-- report during the Dahlia-OFF / E2E period (the thin-bin drift is expected while Dahlia is held off, so
-- the post is pure noise). Suppresses ONLY the Slack post — the pass still runs, detects drift, and
-- authors fix-specs. Gated in src/lib/ads-supervisor.ts `deliverAdsSupervisorDigest`.
alter table public.workspaces
  add column if not exists ads_supervisor_digest_enabled boolean not null default true;

comment on column public.workspaces.ads_supervisor_digest_enabled is
  'When false, suppresses the ads-supervisor drift digest Max posts to #director-growth-max after each '
  '3h supervisory pass (deliverAdsSupervisorDigest early-returns). The pass, drift detection, and fix-spec '
  'authoring are unaffected — only the Slack post is skipped. Default true. (ads-supervisor-digest-toggle)';
