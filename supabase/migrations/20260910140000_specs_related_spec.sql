-- specs.related_spec — a fix-spec's LINK to an origin spec, so a self-healing agent never has to abuse the
-- `parent` column to reference the spec it's fixing.
--
-- THE RULE (no-spec-parent): a spec's `parent` is a function MANDATE or a goal MILESTONE — NEVER another
-- spec. The repair / regression / security / coverage / db-health agents were authoring fix-specs with a
-- `parent` like `extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]]` (a sibling-spec
-- parent), which Vale correctly bounced as needs_fix on every pass — an infinite re-review loop that never
-- built. Those agents parent to `platform#infra-devops-reliability` now; when a fix genuinely relates to an
-- origin spec, that pointer lives HERE (a link, not a parent).
--
-- Nullable text (the origin spec's slug). Distinct from `regression_of_slug` (the regression agent's typed
-- FK that drives `retestOriginIfFixMerged`): `related_spec` is the general "this fix touches that spec" link
-- for any self-healing agent, with no re-test semantics attached. Most specs leave it null.
alter table public.specs add column if not exists related_spec text;

comment on column public.specs.related_spec is
  'no-spec-parent: origin-spec slug a fix-spec relates to (a LINK, never a parent — parent stays a mandate/milestone). Nullable; distinct from regression_of_slug which carries re-test semantics.';
