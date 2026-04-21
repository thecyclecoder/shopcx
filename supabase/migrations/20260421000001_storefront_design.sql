-- Storefront design settings per workspace — font, colors, logo.
-- Rendered storefront reads these via getWorkspaceBySlug().

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS storefront_font TEXT,           -- key into FONTS allowlist (montserrat, poppins, ...)
  ADD COLUMN IF NOT EXISTS storefront_primary_color TEXT,  -- hex, e.g. "#18181b"
  ADD COLUMN IF NOT EXISTS storefront_accent_color TEXT,   -- hex, e.g. "#10b981"
  ADD COLUMN IF NOT EXISTS storefront_logo_url TEXT;

-- Anon reads already exist via 20260420000007; these new columns flow
-- through the same RLS row-level policy so no extra grants needed.

-- Transcoded variant URLs for product media. Populated by the upload
-- endpoint via the Sharp transcoder; nullable so anything uploaded
-- before the pipeline existed keeps working.
ALTER TABLE public.product_media
  ADD COLUMN IF NOT EXISTS webp_url TEXT,
  ADD COLUMN IF NOT EXISTS avif_url TEXT,
  ADD COLUMN IF NOT EXISTS webp_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS avif_storage_path TEXT;

