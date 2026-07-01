-- Capture the visitor's browser language (navigator.language, e.g. es-PR / en-US)
-- on the session so we can size the Spanish-speaking share of traffic and decide
-- whether a Spanish storefront is worth building. First-touch, insert-only.
ALTER TABLE public.storefront_sessions ADD COLUMN IF NOT EXISTS browser_language text;
