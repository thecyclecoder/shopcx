-- Add the per-workspace override read by loadSupportMin in
-- src/lib/playbook-compiler.ts. Default matches the DEFAULT_SUPPORT_MIN
-- constant (15) so existing rows behave identically to the pre-column
-- code path, and the recurring "column workspaces.playbook_compiler_support_min
-- does not exist" postgres ERROR stops leaking into the supabase-logs
-- error feed.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS playbook_compiler_support_min int4 NOT NULL DEFAULT 15;
