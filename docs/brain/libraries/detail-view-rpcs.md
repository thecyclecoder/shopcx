---
title: Detail-view RPCs (Phase 5)
last_updated: 2026-07-08
tags:
  - library
  - rpc
  - tickets
  - customers
brain_refs:
  - [[tables/customer_links]]
  - [[tables/workspace_members]]
  - [[tables/ticket_messages]]
  - [[libraries/customer-timeline]]
  - [[libraries/customer-stats]]
---

# Detail-view RPCs (Phase 5)

Phase 5 of [[../specs/rpc-ify-aggregation-layer-fix-1000-row-truncation]] — two RPCs that collapse the tickets-detail round-trip fan-out and converge every "expand a customer to its link-group" call site on ONE SQL primitive. Migration: [`20261005170000_phase5_detail_view_rpcs.sql`](../../../supabase/migrations/20261005170000_phase5_detail_view_rpcs.sql). Both are `STABLE SECURITY DEFINER SET search_path = public`, `GRANT EXECUTE TO service_role, authenticated`.

## 1. `public.resolve_customer_link_group(p_customer_id uuid) → uuid[]`

Returns the full array of `customer_ids` in the same [[../tables/customer_links]] group as `p_customer_id`, or `[p_customer_id]` when the customer is unlinked. The array is `ORDER BY customer_id` for a stable wire shape.

**Callers converged** (Phase 5):

- [`src/lib/customer-timeline.ts`](../../../src/lib/customer-timeline.ts) `resolveLinkedCustomerIds` — replaces the two-hop JS scan (`SELECT group_id WHERE customer_id=?` → `SELECT customer_id WHERE group_id=?`).
- [`src/app/api/tickets/[id]/route.ts`](../../../src/app/api/tickets/[id]/route.ts) — the ticket-detail customer block used the same open-coded pattern; now calls the RPC once and keeps the `.single()` on `customer_links` only for the `group_id` needed by the "Linked identities" sidebar.

Sibling call sites in [[customer-stats]] (`getCustomerStatsBatch`) still open-code the two-hop for now — they'll converge as their consumers are touched.

**Unlinked customer:** the RPC's `COALESCE` guarantees `[p_customer_id]` back, so the caller never needs to special-case `null`.

## 2. `public.ticket_users(p_workspace uuid, p_user_ids uuid[]) → TABLE(user_id, display_name, email)`

Batched `(user_id → display_name, email)` for [[ticket_messages]] author enrichment on the tickets detail page. Joins [[../tables/workspace_members]] ⨝ `auth.users` in ONE round-trip.

**Replaces** the per-uid `admin.auth.admin.getUserById()` `Promise.all` loop in `src/app/api/tickets/[id]/route.ts` — each auth call crossed the auth service boundary and the response gated on the slowest one. With N distinct author_ids (assigned_to plus every message author), the prior route always paid N sequential auth round-trips before it could respond; now it's one.

**Return shape:** one row per matched `user_id` (rows are dropped for uids that aren't workspace members). The caller falls back to `display_name || email || null` for the rendered author label.

**Security:** `SECURITY DEFINER` because the RPC crosses the `auth` schema boundary to read `auth.users.email`. The admin (service_role) client is the only caller today; the `authenticated` grant is defensive for future authenticated non-admin surfaces that need the same batched lookup.

## Same-PR route changes

- **Tickets detail — messages read bounded.** `src/app/api/tickets/[id]/route.ts` `.select('*').eq('ticket_id', ticketId).order('created_at', asc)` now carries `.limit(500)`. Every real ticket sits well below that (median <20 messages, busiest recorded ~180), so no truncation risk for real payloads. The prior unbounded read would have silently truncated at 1000 once a runaway conversation crossed that.
- **`customer-timeline` variant lookup bounded.** `buildVariantLookup` used to scan every `product_variants` row + every `products` row in the workspace to build the label map — truncated at 1000 as the catalog grew, giving "variant 42614446325933" instead of "Hazelnut". Now takes an explicit `variantIds: string[]` parameter (collected by `collectVariantIdsFromContext` from orders/subs/events IN the window) and issues `.in("shopify_variant_id", ids)` — the catalog fetch is scoped to what actually gets rendered.

## Not built this phase (per spec — labelled Optional)

- `order_detail_bundle(p_workspace, p_order_id)` for `src/app/api/workspaces/[id]/orders/[orderId]/route.ts` — the spec called this out as a latency-only optimization (7 sequential PK/indexed reads, no cap bug). Deferred; the acceptance criteria for Phase 5 explicitly do not require it.

## Verification

- `public.resolve_customer_link_group` / `public.ticket_users` exist with the stated signatures + grants.
- The tickets detail route no longer issues a per-author `getUserById()` loop (grep: `admin.auth.admin.getUserById` returns 0 hits in that file) and the messages read is bounded (`.limit(500)`).
- [`customer-timeline`](../../../src/lib/customer-timeline.ts) `resolveLinkedCustomerIds` calls `admin.rpc('resolve_customer_link_group', ...)` rather than re-querying `customer_links` twice in JS.
- A ticket-detail page and a customer-timeline render return identical data to before (regression check).

## Gotchas

- `resolve_customer_link_group` returns `uuid[]` — the caller reads `data as string[]`, which the Supabase client already surfaces per array-column convention.
- `ticket_users` drops uids that aren't workspace members — a legacy author whose membership was revoked will render with `author_name: null`. That's the same fallback the prior route already carried.
- Adding a new detail-view collapse should reuse `resolve_customer_link_group`, never re-open-code the two-hop expansion. If the group is empty (no `customer_links` row at all), the RPC returns `[p_customer_id]` — the caller's array-length checks are still valid.
