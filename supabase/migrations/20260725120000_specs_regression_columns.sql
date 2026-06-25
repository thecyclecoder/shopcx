-- spec-authoring-writes-db-and-worker-materialize Phase 1: additive columns on public.specs that carry
-- the regression-agent-authored fix's lineage. The regression markdown format already carries these as
-- header lines (`**Regression-of:** [[<slug>]]`, `**Regression-signature:** `<sig>``); moving them onto
-- typed columns lets the board + downstream queries cite the regressed spec + dedupe by signature without
-- re-parsing the body. Sibling to specs.repair_signature for the repair-agent path.
--
-- Idempotent (IF NOT EXISTS). No backfill needed in this migration — the matching backfill script can be
-- re-run to pick the columns up from the markdown.

alter table public.specs
  add column if not exists regression_of_slug text,
  add column if not exists regression_signature text;
