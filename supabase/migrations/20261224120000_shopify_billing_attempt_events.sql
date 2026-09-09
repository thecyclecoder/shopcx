-- shopify_billing_attempt_events — durable record of every subscription_billing_attempts/*
-- webhook Shopify sends us.
--
-- Two jobs, one now and one later:
--
-- 1. NOW (observation). Dunning's only failure trigger today is APPSTLE's webhook
--    (/api/webhooks/appstle/[workspaceId]). Appstle's contracts are Shopify subscription
--    contracts, so it is not yet known whether Shopify also sends US billing-attempt webhooks
--    for contracts owned by Appstle's app. If it does, wiring dunning to this topic straight
--    away would DOUBLE-trigger every failure. So the handler records and does not act, and
--    this table is the evidence for that decision.
--
-- 2. LATER (provenance). Once ShopCX owns billing, every renewal is a
--    subscriptionBillingAttemptCreate whose outcome arrives here. Keeping the raw record makes
--    "why was this customer dunned / not dunned" answerable after the fact, and gives the
--    reconciliation surface something to check the cron's own view against.
--
-- Append-only. `resolved_subscription_id` is null when the contract is not one of ours — which
-- is itself the signal being measured.
--
-- See docs/brain/lifecycles/shopcx-subscriptions.md § Cutover blocker.

create table if not exists public.shopify_billing_attempt_events (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references public.workspaces(id) on delete cascade,
  topic                    text not null,
  shopify_contract_id      text,
  billing_attempt_id       text,
  admin_graphql_api_id     text,
  order_id                 text,
  error_code               text,
  error_message            text,
  -- null = the contract is not in our subscriptions mirror (i.e. not ours). The whole point.
  resolved_subscription_id uuid references public.subscriptions(id) on delete set null,
  payload                  jsonb not null default '{}',
  received_at              timestamptz not null default now()
);

create index if not exists shopify_billing_attempt_events_ws_received_idx
  on public.shopify_billing_attempt_events (workspace_id, received_at desc);
create index if not exists shopify_billing_attempt_events_contract_idx
  on public.shopify_billing_attempt_events (workspace_id, shopify_contract_id);

alter table public.shopify_billing_attempt_events enable row level security;

drop policy if exists shopify_billing_attempt_events_select on public.shopify_billing_attempt_events;
create policy shopify_billing_attempt_events_select
  on public.shopify_billing_attempt_events for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

comment on table public.shopify_billing_attempt_events is
  'Raw subscription_billing_attempts/{success,failure,challenged} webhooks. Records only — dunning is NOT wired to these yet, because Appstle already relays failures and double-triggering would re-dun every customer.';
