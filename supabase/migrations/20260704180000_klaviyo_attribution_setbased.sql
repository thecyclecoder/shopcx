-- Set-based Klaviyo SMS attribution recompute — replaces the per-campaign loop in
-- src/lib/inngest/klaviyo-attribution-compute.ts that, per campaign, ran an UNBOUNDED
-- klaviyo_events select (silently capped at PostgREST max-rows = 1000 → any campaign with
-- >1000 attributed Placed-Order events UNDERCOUNTED revenue on the dashboard) + a per-campaign
-- UPDATE. This aggregates all campaigns in ONE statement, exact (no 1000-row truncation).
--
-- Mirrors the JS logic byte-for-byte: conversions = # attributed Placed-Order events whose
-- value is non-null numeric and whose source_name is NOT a subscription_contract renewal;
-- revenue = sum(value); AOV = revenue/conversions (null when 0). Campaigns with no matching
-- events get 0 / 0 / null (LEFT JOIN), same as the old loop writing every campaign.

create or replace function public.recompute_klaviyo_attribution(
  p_workspace_id uuid,
  p_metric_id text
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  with agg as (
    select h.id,
      count(e.value)                       as n,      -- non-null numeric events (matches JS Number.isFinite guard on a numeric column)
      coalesce(sum(e.value), 0)::numeric   as rev
    from klaviyo_sms_campaign_history h
    left join klaviyo_events e
      on  e.workspace_id = h.workspace_id
      and e.klaviyo_metric_id = p_metric_id
      and e.attributed_klaviyo_campaign_id = h.klaviyo_campaign_id
      and e.value is not null
      and coalesce(e.source_name, '') not like 'subscription_contract%'
    where h.workspace_id = p_workspace_id
    group by h.id
  )
  update klaviyo_sms_campaign_history h
  set initial_conversions               = agg.n,
      initial_conversion_value_cents    = round(agg.rev * 100),
      initial_average_order_value_cents = case when agg.n > 0 then round(agg.rev * 100 / agg.n) else null end,
      initial_revenue_computed_at       = now(),
      updated_at                        = now()
  from agg
  where h.id = agg.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.recompute_klaviyo_attribution(uuid, text) to service_role;
