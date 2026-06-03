-- Ad tool — Phase 0.5: product intelligence -> ad angles.
--
-- One row is one tested direct-response angle the builder can spin variants from.
-- Every angle is ANCHORED to a tier-1 or tier-2 proven benefit (from
-- product_page_content.benefit_bar OR product_benefit_selections.name) — the
-- generator refuses to write angles that don't trace back to a real source row.
--
-- See docs/brain/specs/ad-tool.md "Data-source contract" for the tier hierarchy.

CREATE TABLE IF NOT EXISTS public.product_ad_angles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,

  -- One of the 12 hook formulas (problem_now | contrarian | results_first |
  -- callout | enemy | secret_reveal | urgent_question | social_proof_shock |
  -- visual_shock | story_in_progress | keeping_up | loved_one_at_risk).
  hook_slug TEXT NOT NULL,

  -- Which Life Force 8 desire this angle targets (1..8).
  lf8_slot INTEGER NOT NULL CHECK (lf8_slot BETWEEN 1 AND 8),

  -- The tier-1 or tier-2 benefit this angle promises. Verbatim from
  -- benefit_bar[].text OR lead_benefits[].name. REQUIRED — the anchoring contract.
  lead_benefit_anchor TEXT NOT NULL,

  -- The customer's existing pain in their language (from customer_phrases or a
  -- proof_quote — never invented).
  pain_now TEXT,
  -- The LF8-aligned outcome, in the customer's voice.
  desired_outcome TEXT,
  -- The populated hook (<= 15 words), plug-and-play into the script.
  hook_one_liner TEXT,

  -- The specific proof citation backing the outcome.
  -- { type: 'review'|'science'|'award'|'stat', value, source_id? }
  proof_anchor JSONB,

  -- limited_batch | selling_out | price_increase_soon | seasonal | none
  urgency_lever TEXT NOT NULL DEFAULT 'none',
  -- Optional: who/what the ad is positioned against.
  enemy TEXT,
  -- ugly | loud | weird | phone_recorded | clinical
  vibe_tags TEXT[] NOT NULL DEFAULT '{}',

  -- Meta Ads Manager copy fields, auto-generated with the script. Hard caps
  -- enforced by the safety layer (the DB CHECK is a backstop).
  meta_headline TEXT,         -- <= 40 chars
  meta_primary_text TEXT,     -- <= 125 chars
  meta_description TEXT,       -- <= 30 chars

  -- ai | agent | imported
  generated_by TEXT NOT NULL DEFAULT 'ai',

  times_used INTEGER NOT NULL DEFAULT 0,
  last_performance JSONB,

  -- Re-runs append new angles and archive older ones (is_active=false) so the
  -- picker stays clean without losing history.
  is_active BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT product_ad_angles_meta_headline_cap CHECK (meta_headline IS NULL OR char_length(meta_headline) <= 40),
  CONSTRAINT product_ad_angles_meta_primary_cap CHECK (meta_primary_text IS NULL OR char_length(meta_primary_text) <= 125),
  CONSTRAINT product_ad_angles_meta_desc_cap CHECK (meta_description IS NULL OR char_length(meta_description) <= 30)
);

-- Picker reads "active angles for this product, newest first".
CREATE INDEX IF NOT EXISTS product_ad_angles_active_lookup_idx
  ON public.product_ad_angles (workspace_id, product_id, created_at DESC)
  WHERE is_active = true;

ALTER TABLE public.product_ad_angles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "product_ad_angles_select_own_workspace" ON public.product_ad_angles;
DROP POLICY IF EXISTS "product_ad_angles_service_role_all" ON public.product_ad_angles;

CREATE POLICY "product_ad_angles_select_own_workspace" ON public.product_ad_angles
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "product_ad_angles_service_role_all" ON public.product_ad_angles
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');
