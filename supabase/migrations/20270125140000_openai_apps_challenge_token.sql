-- OpenAI Apps (ChatGPT directory) domain-verification token, per workspace
-- (docs/brain/recipes/list-ai-shopping-agent.md · Phase 4 of the AI-shopping-agent build).
--
-- OpenAI verifies ownership of the storefront domain by having it serve a token at
-- /.well-known/openai-apps-challenge. The token is NOT a secret — it is served openly at that path
-- by design — so it is stored PLAIN (encrypting a value you then publish would be pointless; the
-- CLAUDE.md `_encrypted` rule is for actual secrets like processor keys).

alter table public.workspaces
  add column if not exists openai_apps_challenge_token text;

comment on column public.workspaces.openai_apps_challenge_token is
  'OpenAI Apps domain-verification token, served publicly at /.well-known/openai-apps-challenge. Not a secret — stored plain. See docs/brain/recipes/list-ai-shopping-agent.md.';
