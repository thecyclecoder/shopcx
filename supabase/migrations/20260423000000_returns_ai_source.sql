-- Allow 'ai' and 'system' as return sources
ALTER TABLE public.returns DROP CONSTRAINT IF EXISTS returns_source_check;
ALTER TABLE public.returns ADD CONSTRAINT returns_source_check
  CHECK (source IN ('playbook', 'agent', 'portal', 'shopify', 'ai', 'system'));
