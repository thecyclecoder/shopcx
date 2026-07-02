-- creative_skeletons.landing_page_url — the FULL ad destination URL WITH path (from AdLibrary's
-- `landing_page_url`, present on the ~half of ads that carry it), e.g. https://learn.erthlabs.co/women50.
-- This is the real advertorial the landing-page-scout captures; the bare `destination_domain` root often
-- 404s (the advertorial lives at a slug). Populated by creative-skeleton.ingestAd; preferred over
-- destination_domain by landing-page-scout.adDestinationsForBrand.
alter table public.creative_skeletons add column if not exists landing_page_url text;
