-- Add policy URL to playbook policies for linking to published policy pages
ALTER TABLE public.playbook_policies ADD COLUMN IF NOT EXISTS policy_url TEXT;
