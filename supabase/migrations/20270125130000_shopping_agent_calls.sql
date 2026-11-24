-- shopping_agent_calls — the supervision log for the public AI shopping-agent MCP server
-- (docs/brain/tables/shopping_agent_calls.md · Phase 2 of the AI-shopping-agent build).
--
-- One row per MCP tool call: which platform (chatgpt / claude / grok / other, from
-- initialize.clientInfo), which tool, REDACTED args (no free-text shopper health details — only
-- coarse fields like a situation slug match + product ids), the result product ids, the
-- blocked-claim count (how many quotes/sentences the compliance module dropped), latency, and when.
--
-- North-star: this is the "answers to a supervisor" half of the supervisable-autonomy trio — the
-- CMO owns the node, the kill switch stops it, and this log makes every call visible. NO raw shopper
-- health text is ever persisted here (spec Phase 2: "No shopper health text persisted").
--
-- Writes go only through src/lib/shopping-agent/calls.ts (service-role).

create table if not exists public.shopping_agent_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Which AI app connected: chatgpt | claude | grok | other (from initialize.clientInfo name).
  platform text not null default 'other',
  -- The MCP tool invoked (search_products, find_products_for_situation, …).
  tool text not null,
  -- Redacted args — NO free-text health details. Coarse fields only (e.g. { situation_slug, product_id }).
  args jsonb not null default '{}'::jsonb,
  -- Product ids returned by the call (internal UUIDs).
  result_product_ids uuid[] not null default '{}',
  -- How many quotes/sentences the compliance module DROPPED on this call (supervision signal).
  blocked_claim_count integer not null default 0,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists shopping_agent_calls_ws_created_idx
  on public.shopping_agent_calls (workspace_id, created_at desc);
create index if not exists shopping_agent_calls_platform_idx
  on public.shopping_agent_calls (workspace_id, platform, created_at desc);

-- ── RLS — workspace-member SELECT, service-role write (mirror storefront_levers) ──
alter table public.shopping_agent_calls enable row level security;
drop policy if exists shopping_agent_calls_select on public.shopping_agent_calls;
create policy shopping_agent_calls_select on public.shopping_agent_calls
  for select to authenticated using (auth.uid() is not null);
drop policy if exists shopping_agent_calls_service on public.shopping_agent_calls;
create policy shopping_agent_calls_service on public.shopping_agent_calls
  for all to service_role using (true) with check (true);

comment on table public.shopping_agent_calls is
  'Supervision log for the public AI shopping-agent MCP server: platform, tool, redacted args (no shopper health text), result product ids, blocked-claim count, latency. Writes via src/lib/shopping-agent/calls.ts only. See docs/brain/tables/shopping_agent_calls.md.';
