---
title: Order-aggregation RPCs
last_updated: 2026-07-08
tags:
  - library
  - rpc
  - orders
  - storefront
brain_refs:
  - [[tables/orders]]
  - [[tables/customers]]
  - [[tables/workspaces]]
  - [[libraries/funnel-tree]]
---

# Order-aggregation RPCs

Five SQL primitives that fix aggregation correctness + kill unbounded [[../tables/orders]] egress from callers that previously paged or unbounded-selected the table (Phase 3 of the 1000-row truncation fix). Migration: [`20261005150000_phase3_order_rpcs.sql`](../../../supabase/migrations/20261005150000_phase3_order_rpcs.sql).

All functions `SET search_path = public`. All read-only functions are `SECURITY DEFINER` + `GRANT EXECUTE TO service_role, authenticated`. The internal predicate `amplifier_is_late` is `IMMUTABLE` (composed inside other RPC WHERE clauses).

## 1. `public.amplifier_is_late(received, sla, cutoff_hour, tz, shipping_days)` (internal)

SQL parity port of `isWithinSLA` in [`src/app/api/workspaces/[id]/orders/route.ts`](../../../src/app/api/workspaces/[id]/orders/route.ts). Given an amplifier-received timestamp, workspace SLA (days), cutoff hour, IANA timezone, and the ISO 1..7 shipping-day array, returns `true` when the current wall clock in TZ is past the SLA deadline (23:59:59 on the deadline shipping day). Preserves the JS logic bit-for-bit:

1. Convert `received` to the workspace TZ.
2. If the received hour is ≥ cutoff, roll to the next day.
3. Advance to the next shipping day (Postgres `isodow` matches the JS `toISO()` the original used).
4. Count `sla_days` more shipping days.
5. Compare `now() AT TIME ZONE tz` against the deadline.

Composed inline as an `AND` clause on the late-tracking candidate set — the planner does NOT push it into an index, but the composed candidate set is already small (paid + amplifier row + not-shipped + not-fulfilled), so a seq test over that set is fine.

## 2. `public.orders_late_tracking_count(p_workspace, p_sla_days, p_cutoff_hour, p_cutoff_timezone, p_shipping_days) → bigint`

Cheap true-count for `/api/workspaces/:id/orders?counts=true`. Replaces the JS `for (o of candidates) if (!isWithinSLA(...)) lateTracking++` loop over a candidate select the 1000-row PostgREST cap silently truncated.

## 3. `public.orders_late_tracking(p_workspace, …, p_sort, p_order, p_limit, p_offset) → TABLE(total_count, …order columns…, customer_email, customer_first_name, customer_last_name)`

Paginated late-tracking list for `/api/workspaces/:id/orders?filter=late_tracking`. Applies the SLA predicate SERVER-SIDE, computes `total_count = COUNT(*) OVER ()` over the fully-late set, and paginates last — the prior route fetched every match, JS-sliced, and returned a `total` that was actually just the current page count when the source truncated.

Sort space: `created_at` (default, `desc`) · `order_number` · `total_cents` · `fulfillment_status` — matches the four `validSorts` keys the route already accepts.

Returned columns mirror the prior `.select(...)` list + a joined `customers` (`{id, email, first_name, last_name}`); the route rebuilds the nested customer object on the app side to keep the frontend contract unchanged.

## 4. `public.order_source_counts(p_workspace) → TABLE(source_name, cnt)`

Server-side `GROUP BY COALESCE(source_name, '(unknown)')` for [`src/app/api/workspaces/[id]/order-sources/route.ts`](../../../src/app/api/workspaces/[id]/order-sources/route.ts) — replaces a `while(true) .range(0, 999)` loop that paged the entire orders table into a JS Map just to count. Sorted `cnt DESC` for the caller.

## 5. `public.order_times_by_email(p_workspace, p_emails text[]) → TABLE(email, order_times timestamptz[])`

Server-side per-email order-time aggregation for the cart-recovery post-reminder-purchase test in [`src/lib/storefront/funnel-tree.ts`](../../../src/lib/storefront/funnel-tree.ts). Prior code chunked `customer_ids` in groups of 200 and issued `admin.from("orders").select("customer_id, created_at").in("customer_id", chunk)` — a chunk with more than 1000 order rows silently dropped the tail past PostgREST's cap, so the "customer ordered AFTER the reminder" test under-counted recovered carts and revenue on any high-order workspace.

Joins `customers` (workspace-scoped, case-insensitive email match) → `orders` (via `customer_id`), returns one row per email in `p_emails` with a `timestamptz[]` array of that email's order times. The caller still batches its email list (500 at a time) as a wire-shape belt, and unions the batches into a single `Map<email, number[]>` (matching the prior shape) before running the reminder-time comparison.

## Verification

- `public.amplifier_is_late` / `orders_late_tracking_count` / `orders_late_tracking` / `order_source_counts` / `order_times_by_email` exist with the stated signatures + grants.
- The three routes / one lib call `admin.rpc(...)` for their respective RPC — no route still issues an unbounded `.select()` or a paged `while(true)` scan over `orders`.
- Late-tracking tab `total` matches a raw SQL `COUNT(*)` over the full late set (>1000) rather than a 1000-capped slice.
- `order-sources` issues a single RPC call instead of the paging loop.
- Cart-recovery `revenue_recovered_cents` / `recovered` match a full-join SQL result on a >1000-order cohort.

## Gotchas

- `amplifier_is_late` is workspace-config-parameterized (SLA, cutoff hour, TZ, shipping days). The caller reads those from `workspaces` first and passes them per-call; the RPC does NOT re-read the workspace, keeping it pure.
- Postgres returns `bigint` (including `total_count` on `orders_late_tracking`, `cnt` on `order_source_counts`, `total_cents`) as a STRING on the wire — the caller coerces with `Number(v) || 0`.
- `order_times_by_email` returns 0 rows for an empty input — the caller must default the map to `[]` per email.
- `orders.workspace_id` is enforced by the RPC's `WHERE workspace_id = p_workspace`; `orders_late_tracking` joins `customers` unconditionally on `customer_id` so a cross-workspace customer row can't leak (customers PK is workspace-partitioned in practice; the join is a LEFT to tolerate an orphan).
