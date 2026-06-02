-- Multi-line free-form text of the brand's strongest proof points
-- (money-back guarantee, customer counts, certifications, science
-- backing, etc.) used by the social-comment orchestrator to build
-- value publicly when a commenter raises a price/affordability
-- objection. Editable per workspace; nullable.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS social_brand_proof_points TEXT;

COMMENT ON COLUMN public.workspaces.social_brand_proof_points IS
  'Brand value props the social-comment AI weaves into public replies on price objections. Free-form text, one proof point per line.';
