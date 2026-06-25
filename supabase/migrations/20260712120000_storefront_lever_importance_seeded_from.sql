-- Schema-drift fix: the live public.storefront_lever_importance table was created
-- by 20260624120000_storefront_levers.sql before the seeded_from column was added
-- to that migration. Because that migration uses CREATE TABLE IF NOT EXISTS, the
-- column was never added retroactively, and every lever-memory updatePosterior
-- INSERT now fails with 42703 — leaving the learned posterior store empty and the
-- funnel-dashboard "What the agent believes matters" panel hidden.
--
-- This is a tiny additive ALTER that brings the live schema back in line with the
-- migration file. Safe to re-run.

alter table public.storefront_lever_importance
  add column if not exists seeded_from text not null default 'cro_prior';

-- Defensive: ensure no row is left with a null seeded_from (the NOT NULL above
-- handles new rows; this fixes any prior rows that somehow snuck in nullable).
update public.storefront_lever_importance
  set seeded_from = 'cro_prior'
  where seeded_from is null;
