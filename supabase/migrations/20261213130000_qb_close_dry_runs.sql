-- Shoptics→ShopCX close CUTOVER, Phase 2: the dry-run verdict ledger.
--
-- Posting a month-end close is largely IRREVERSIBLE — the JournalEntry is idempotent, but the
-- InventoryAdjustment and the three SalesReceipts are not (no void, no dedup), so a second run
-- duplicates real QuickBooks documents and corrupts inventory. The posting path therefore
-- refuses unless a dry run for that month has been recorded here AND passed.
--
-- Why a ledger rather than a boolean: the July 2026 dry run needed six passes before it was
-- trustworthy ($85,864 → $2,364), each pass changing a different input. Keeping every attempt
-- makes "what did we know when we posted?" answerable after the fact, and makes a regression
-- between two dry runs visible instead of silently overwritten.
--
-- `passed` is computed by src/lib/qb-close/close-guard.ts, never set by hand.
-- See docs/brain/libraries/qb-close-guard.md.

create table if not exists public.qb_close_dry_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  closing_month text not null,                      -- 'YYYY-MM'
  ran_at timestamptz not null default now(),

  -- verdict
  passed boolean not null default false,
  blocking_issues jsonb not null default '[]'::jsonb,   -- [{code, detail}] — empty iff passed
  warnings jsonb not null default '[]'::jsonb,          -- non-blocking observations

  -- journal entry
  je_balanced boolean,
  je_total_debits numeric(14,2),
  je_total_credits numeric(14,2),
  je_line_count integer,

  -- inventory adjustment
  adjustment_line_count integer,
  adjustment_abs_units integer,
  adjustment_value numeric(14,2),                   -- Σ |QtyDiff| × unit_cost

  -- sales receipts, units per channel
  receipt_units jsonb,                              -- {amazon, shopify, internal}

  -- input health — the class of failure that actually bit us: a silently-degraded input
  -- (empty opening book, missing processor rollup, a QB receipts lookup swallowed by a bare
  -- catch) produces a confident, balanced, WRONG close.
  input_health jsonb,                               -- {opening_book_rows, processor_count, received_items, fba_snapshot_date, tpl_snapshot_date, shopify_order_count}

  created_at timestamptz not null default now()
);

create index if not exists idx_qb_close_dry_runs_lookup
  on public.qb_close_dry_runs(workspace_id, closing_month, ran_at desc);

alter table public.qb_close_dry_runs enable row level security;
drop policy if exists qb_close_dry_runs_member_read on public.qb_close_dry_runs;
create policy qb_close_dry_runs_member_read on public.qb_close_dry_runs for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
