-- Phase 1 of docs/brain/specs/carrie-dr-content.md — the DR-content STORE.
--
-- Two things ship together because they're the same idea:
--
-- 1) product_media grows three columns — `category`, `source`, `caption` — so a
--    Nano-Banana-generated asset (or an uploaded UGC selfie) is permanent,
--    categorized product intelligence keyed by product_id (not a slot-name pun
--    like `endorsement_1_avatar`). Carrie's dr-content session reads by
--    `category` when deciding "do we already have a lifestyle shot for this
--    product?" — that read is the whole point of `category`.
--
-- 2) lander_content_gaps — one row per REAL-EVIDENCE asset slot Carrie can't
--    ethically generate (before/after, UGC selfie, testimonial photo, press
--    logo). Carrie NEVER fabricates a customer result; she opens a gap row
--    routed to Max (owner_function='growth' for the `dr-content` action kind
--    in approval-inbox) with a plain-language description of what to shoot or
--    supply. On resolve the row points at the resolved product_media row.
--
-- Chokepoint: all WRITES go through src/lib/lander-blueprints.ts (the
-- carrie-dr-content SDK — same file as lander_blueprints since gaps are a
-- lifecycle appendix of a blueprint). No raw
-- .from('lander_content_gaps').insert|update|upsert outside the SDK.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) product_media — DR content columns
-- ─────────────────────────────────────────────────────────────────────────────

-- Persuasive job of the asset (what kind of proof/illustration it carries).
-- Free-text with a CHECK so the vocabulary is documented but extending it is a
-- one-line change (before_after | ugc | testimonial_photo | press_logo |
-- lifestyle | hero | ingredient | mechanism | other).
ALTER TABLE public.product_media
  ADD COLUMN IF NOT EXISTS category TEXT;

-- Where the asset came from — so the DR content session (and the reviewer
-- opening a blueprint later) can tell a generated hero from an uploaded UGC
-- selfie at a glance.
ALTER TABLE public.product_media
  ADD COLUMN IF NOT EXISTS source TEXT;

-- Plain-language caption Carrie writes next to a generated asset (or a founder
-- upload). Not the same as `alt_text` (which is SEO-shaped for the storefront).
-- This is the DR caption: "our Amazing Coffee mixed into oat milk, close-up."
ALTER TABLE public.product_media
  ADD COLUMN IF NOT EXISTS caption TEXT;

-- Constrain the two vocabularies. `IF NOT EXISTS` on ADD CONSTRAINT isn't
-- portable — we DROP-then-ADD so re-running the migration is idempotent.
ALTER TABLE public.product_media
  DROP CONSTRAINT IF EXISTS product_media_category_check;
ALTER TABLE public.product_media
  ADD CONSTRAINT product_media_category_check
  CHECK (category IS NULL OR category IN (
    'before_after',
    'ugc',
    'testimonial_photo',
    'press_logo',
    'lifestyle',
    'hero',
    'ingredient',
    'mechanism',
    'other'
  ));

ALTER TABLE public.product_media
  DROP CONSTRAINT IF EXISTS product_media_source_check;
ALTER TABLE public.product_media
  ADD CONSTRAINT product_media_source_check
  CHECK (source IS NULL OR source IN (
    'uploaded',
    'generated',
    'scout',
    'shopify'
  ));

-- Read-path index: Carrie's "do we already have an X for this product?" probe.
CREATE INDEX IF NOT EXISTS idx_product_media_product_category
  ON public.product_media (workspace_id, product_id, category)
  WHERE category IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2) lander_content_gaps
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lander_content_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- The blueprint this gap belongs to. ON DELETE CASCADE — a purged blueprint
  -- takes its gaps with it (they're a lifecycle appendix, not standalone work).
  blueprint_id UUID NOT NULL REFERENCES public.lander_blueprints(id) ON DELETE CASCADE,

  -- The persuasive job of the missing asset — must be one Carrie can NEVER
  -- ethically generate (before/after transformation, UGC selfie, testimonial
  -- photo, press/certification logo). `other` is the escape hatch.
  asset_role TEXT NOT NULL CHECK (asset_role IN (
    'before_after',
    'ugc',
    'testimonial_photo',
    'press_logo',
    'other'
  )),

  -- Which skeleton block on the blueprint needs this asset (e.g. `reason_1`,
  -- `hero`, `faq`). Free-text — mirrors lander_blueprints.skeleton.blocks[].role.
  block_ref TEXT NOT NULL,

  -- Plain-language description written for the FOUNDER — "please supply a
  -- 3-photo before/after story from a customer who lost 15+lb on the coffee.
  -- Landscape orientation." No jargon, no lever names.
  description TEXT NOT NULL,

  -- 'open'   — waiting on the founder to upload / supply the asset.
  -- 'resolved' — the founder uploaded; `resolved_media_id` points at the row.
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),

  -- The product_media row the resolution landed on. Nullable while open,
  -- populated on resolve. ON DELETE SET NULL so a purged media row leaves the
  -- gap-history in place (audit trail).
  resolved_media_id UUID REFERENCES public.product_media(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Read-path indexes:
--   • Carrie's "any open gaps left on this blueprint?" — drives the blueprint
--     status transition (awaiting_upload vs content_complete).
--   • Max's inbox: workspace-wide open-gap queue.
CREATE INDEX IF NOT EXISTS lander_content_gaps_blueprint_status_idx
  ON public.lander_content_gaps (blueprint_id, status);
CREATE INDEX IF NOT EXISTS lander_content_gaps_workspace_status_idx
  ON public.lander_content_gaps (workspace_id, status);

-- updated_at auto-bump on any UPDATE (mirrors lander_blueprints_touch_updated_at).
CREATE OR REPLACE FUNCTION public.lander_content_gaps_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lander_content_gaps_touch_updated_at ON public.lander_content_gaps;
CREATE TRIGGER lander_content_gaps_touch_updated_at
  BEFORE UPDATE ON public.lander_content_gaps
  FOR EACH ROW EXECUTE FUNCTION public.lander_content_gaps_touch_updated_at();

ALTER TABLE public.lander_content_gaps ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'lander_content_gaps' AND policyname = 'lander_content_gaps_select'
  ) THEN
    CREATE POLICY lander_content_gaps_select ON public.lander_content_gaps FOR SELECT
      USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'lander_content_gaps' AND policyname = 'lander_content_gaps_service'
  ) THEN
    CREATE POLICY lander_content_gaps_service ON public.lander_content_gaps FOR ALL
      USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
