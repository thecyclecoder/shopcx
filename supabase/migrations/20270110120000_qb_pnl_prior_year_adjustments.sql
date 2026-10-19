-- Exclude the one-off "85000 Prior Year Adjustment" from real profit (CEO 2026-10-19).
--
-- Sep 2026 booked a $125.5K prior-year true-up under Other Expenses. Real profit
-- (adjusted_net_income) was net_income + management_fees only, so it read -$82.2K for a
-- ~$43K month — and the in-progress estimate averages (adjusted − operating) over the last
-- three closed months, which dragged October's estimate down ~$42K (to about -$7K).
--
-- New column: prior_year_adjustments (positive expense). adjusted_net_income now adds it back:
--   adjusted_net_income = net_income + management_fees + prior_year_adjustments
-- parsePnlRollups (src/lib/quickbooks.ts) writes both going forward; this backfills every
-- stored snapshot from its own raw report. Idempotent: re-running recomputes the same values.

alter table public.qb_pnl_snapshots add column if not exists prior_year_adjustments numeric;

update public.qb_pnl_snapshots s
set prior_year_adjustments = pya.amount,
    adjusted_net_income = s.net_income + coalesce(s.management_fees, 0) + coalesce(pya.amount, 0),
    updated_at = now()
from (
  select q.id,
         (select (o->'ColData'->-1->>'value')::numeric
            from jsonb_path_query(q.raw, 'strict $.** ? (@.type == "Data")') o
           where o->'ColData'->0->>'value' ~* 'prior year adjustment'
           limit 1) as amount
  from public.qb_pnl_snapshots q
) pya
where pya.id = s.id
  and s.net_income is not null;
