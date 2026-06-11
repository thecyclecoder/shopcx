-- Storefront launch floor for the funnel.
--
-- The funnel never counts data before this instant — everything prior is
-- pre-launch testing + Meta ad-review crawler traffic, not real customers.
-- The funnel API clamps its start boundary to max(requested_start, launch_at),
-- so even a wide date range can't surface pre-launch noise. Per-workspace so
-- each tenant sets its own go-live moment; null = no floor (count everything).

alter table public.workspaces
  add column if not exists storefront_launch_at timestamptz;
