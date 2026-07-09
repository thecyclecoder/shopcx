---
title: public.list_subscriptions RPC
last_updated: 2026-07-08
tags:
  - library
  - rpc
  - subscriptions
brain_refs:
  - [[tables/subscriptions]]
  - [[tables/customers]]
  - [[tables/dunning_cycles]]
---

# `public.list_subscriptions`

Phase 2 of [[../specs/rpc-ify-aggregation-layer-fix-1000-row-truncation]] — the server-side subscription-list RPC that backs the `/dashboard/subscriptions` list view. Migration: [`20261005140000_list_subscriptions_rpc.sql`](../../../supabase/migrations/20261005140000_list_subscriptions_rpc.sql). Sole caller: [`src/app/api/workspaces/[id]/subscriptions/route.ts`](../../../src/app/api/workspaces/[id]/subscriptions/route.ts).

## Why

The prior route implementation carried two correctness bugs the audit flagged:

1. **Product filter (was route.ts:51-66).** `?products=<ids>` fetched every subscription in the workspace via `subscriptions.select('id, items').eq('workspace_id', …)` — **no `.range()`** — and containment-checked the items array in JS. PostgREST silently truncates that scan at 1000 rows, so any workspace with more than 1000 subs was missing matches past the cap. The filtered set and `total` both shrank on every request.
2. **Recovery filter after pagination (was route.ts:94, 105-166).** `query.range(offset, offset + limit - 1)` ran BEFORE the dunning-cycles join + the JS `recovery_status === X` filter. With `?recovery=…` set, both `subscriptions` and `total` reflected only the current page's post-page-filter subset, not the full filtered population.

`public.list_subscriptions` fixes both by moving every filter (status, payment, product, search, recovery) + sort + pagination into SQL, computing `total_count` as a window function over the fully filtered set, and paginating LAST.

## Signature

```sql
list_subscriptions(
  p_workspace     uuid,
  p_status        text,      -- 'active' | 'paused' | 'cancelled' | 'expired' | NULL/'all'
  p_payment       text,      -- 'succeeded' | 'failed' | 'skipped' | NULL/'all'
  p_recovery      text,      -- 'in_recovery' | 'recovered' | 'failed' | NULL/'all'
  p_search        text,      -- ilike over customers.email / first_name / last_name; NULL/'' = no search
  p_product_ids   text[],    -- items @> [{"product_id": id}] for ANY id; NULL/'{}' = no product filter
  p_sort          text,      -- 'next_billing_date' | 'created_at' | 'status'
  p_order         text,      -- 'asc' | 'desc'
  p_limit         int,
  p_offset        int
) RETURNS TABLE(
  total_count bigint,        -- COUNT(*) OVER () over the filtered set — repeated per row
  id uuid,
  shopify_contract_id text,
  shopify_customer_id text,
  status text,
  items jsonb,
  billing_interval text,
  billing_interval_count int,
  next_billing_date timestamptz,
  last_payment_status text,
  delivery_price_cents bigint,
  created_at timestamptz,
  updated_at timestamptz,
  customer_id uuid,
  customer_email text,
  customer_first_name text,
  customer_last_name text,
  recovery_status text        -- 'in_recovery' | 'recovered' | 'failed' | NULL
)
```

`LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public`. `GRANT EXECUTE TO service_role, authenticated`.

## Correctness details

- **Product containment:** each element of `p_product_ids` is expanded to a `[{"product_id": <id>}]` shape, then `EXISTS (jsonb_array_elements(shapes) q WHERE s.items @> q.shape)` picks any subscription whose items contain ANY of the requested products. Backed by `idx_subscriptions_items_gin` (created in [`20260708120000_estimate_sub_ltv_rpc.sql`](../../../supabase/migrations/20260708120000_estimate_sub_ltv_rpc.sql)).
- **Latest dunning cycle per contract:** `LEFT JOIN LATERAL (SELECT status, recovered_at FROM dunning_cycles WHERE workspace_id = s.workspace_id AND shopify_contract_id = s.shopify_contract_id ORDER BY cycle_number DESC LIMIT 1)` — the SQL analog of the JS "keep first" pass over `.order('cycle_number', {ascending: false})`.
- **`recovery_status` derivation** mirrors the prior JS branches: `active|skipped → in_recovery`; `paused|exhausted → failed`; `recovered` (within the last 7 days per `recovered_at`) → `recovered`; else NULL.
- **Recovery filter runs BEFORE pagination** — the `recovery_filtered` CTE narrows the annotated set; `total_count` is a `COUNT(*) OVER ()` window over that filtered set, then `LIMIT/OFFSET` applies. Every returned row carries the same `total_count`; the caller reads `rows[0].total_count` (or 0 when empty).
- **Sort:** parametric on `p_sort ∈ {next_billing_date, created_at, status}` × `p_order ∈ {asc, desc}` — six `CASE` branches on ORDER BY; unknown sort defaults to `next_billing_date`.
- **MRR** is NOT computed in the RPC. The caller keeps the existing per-row items reduce + interval-normalization, so the wire shape and math stay in one place. Only the truncation-prone predicates moved into SQL.

## Response shape (unchanged from route contract)

```json
{
  "subscriptions": [
    {
      "id": "…",
      "shopify_contract_id": "…",
      "shopify_customer_id": "…",
      "status": "active",
      "items": [{ "product_id": "…", "price_cents": 4500, "quantity": 1 }],
      "billing_interval": "month",
      "billing_interval_count": 1,
      "next_billing_date": "2026-08-01T…",
      "last_payment_status": "succeeded",
      "delivery_price_cents": 0,
      "created_at": "…", "updated_at": "…",
      "customer_id": "…",
      "customers": { "id": "…", "email": "…", "first_name": "…", "last_name": "…" },
      "recovery_status": null,
      "mrr_cents": 4500
    }
  ],
  "total": 12345
}
```

## Gotchas

- The RPC does not require an authenticated principal — the route enforces auth at the app layer and calls the RPC through the admin (service_role) client. Downstream authenticated callers of this RPC would be gated only by workspace membership at the app layer.
- Empty result set returns zero rows → the caller MUST treat missing `rows[0]` as `total=0`, not crash.
- `p_product_ids` accepts `null` or `text[]` — both are treated as "no product filter". Filter out empty strings on the caller side so the containment shape can't degenerate to `{"product_id": ""}`.
- Postgres returns `bigint` (including `total_count` and `delivery_price_cents`) as a string on the wire — the caller coerces with `Number(v) || 0`.
- Adding a new filter parameter (or a new sort column) requires a `DROP FUNCTION` + `CREATE OR REPLACE` migration — the return signature is frozen once shipped.
