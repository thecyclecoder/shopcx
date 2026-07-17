-- ad_campaigns.concept_tag — Andromeda concept-diversity taxonomy (docs/brain/specs/dahlia-andromeda-concept-diversity-tags.md Phase 1).
--
-- Dahlia's per-creative author box session (kind='ad-creative-copy-author') tags every
-- ok-verdict creative with one of the 10 Andromeda concept tokens so Bianca's replenish
-- path (Phase 2) can enforce test-cohort concept diversity — no more than one same-tag
-- creative live per cohort, so a same-concept win generalizes and a same-concept loss
-- is attributable to the concept rather than to execution. Without this taxonomy an
-- author-mode session with a transformation-heavy competitor shelf can emit 4/4
-- transformation captions that Meta fatigues in lockstep, degrading the CAC/CTR compare
-- author-vs-deterministic into a same-concept-comparison — measurement noise, not a
-- concept-diverse win.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS, no backfill). Existing rows remain
-- NULL, which the Phase-2 diversity gate treats as its own bucket 'untagged' — a NULL
-- candidate never conflicts with an Andromeda-tagged live campaign (keeps deterministic-
-- mode replenish behavior byte-identical when DAHLIA_COPY_MODE=deterministic).
--
-- CHECK constrains the column to exactly the 10 Andromeda tokens (or NULL) so a stray
-- write can't degrade the column into free-form text — the taxonomy is the schema.
alter table public.ad_campaigns
  add column if not exists concept_tag text
    check (concept_tag is null or concept_tag in (
      'transformation',
      'objection',
      'curiosity',
      'mechanism',
      'authority',
      'social-proof',
      'scarcity',
      'negation',
      'story',
      'comparison'
    ));

comment on column public.ad_campaigns.concept_tag is
  'Andromeda concept-diversity token stamped by Dahlia''s author box session on every ok verdict; one of transformation | objection | curiosity | mechanism | authority | social-proof | scarcity | negation | story | comparison, or NULL for deterministic buildMetaCopyPack inserts + pre-Phase-1 rows. Read by Bianca''s media-buyer-agent replenish path (Phase 2) to skip a candidate whose tag is already represented in the live cohort — enforces concept diversity so a same-concept win generalizes and a same-concept loss is attributable to concept, not execution.';

-- Partial index to serve the Phase-2 diversity read (compute the distinct live-tag Set
-- per workspace). Partial ON `concept_tag is not null` keeps the index tiny (only tagged
-- rows) and matches the exact filter the replenish path uses.
create index if not exists ad_campaigns_workspace_concept_tag_idx
  on public.ad_campaigns (workspace_id, concept_tag)
  where concept_tag is not null;
