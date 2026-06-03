-- Google AI Studio (Gemini) integration — per-workspace, encrypted.
--
-- Powers the ad-tool "holding product" step (Nano Banana Pro = gemini-3-pro-image,
-- multi-image combine of the avatar face + the product's isolated image). Same
-- AES-256-GCM pattern as the other integration credentials.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS gemini_api_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS gemini_project_id TEXT;

COMMENT ON COLUMN public.workspaces.gemini_api_key_encrypted IS
  'Google AI Studio (Gemini) API key, AES-256-GCM via src/lib/crypto.ts. Auth: x-goog-api-key header. Used for Nano Banana Pro (gemini-3-pro-image) face+product combine.';
COMMENT ON COLUMN public.workspaces.gemini_project_id IS
  'Google Cloud project number for the Gemini key (informational; billing must be enabled on it for the Pro image model).';
