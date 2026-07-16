# media_buyer_all_customers_refresh_runs

One row per successful weekly refresh of the CUSTOMER_LIST (all-customers, hashed) exclusion audience per `(workspace, ad_account, audience)`. Carries the watermark the NEXT run reads so the incremental upload never re-sends the whole customer base. Written by [[../inngest/media-buyer-all-customers-refresh]] at end of each successful group.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid` | ✓ | → [[meta_ad_accounts]].id · ON DELETE SET NULL — the account whose CUSTOMER_LIST audience was refreshed |
| `audience_id` | `text` | — | bare Meta customaudience id (client adds no prefix — NOT our uuid) of the CUSTOMER_LIST audience refreshed |
| `watermark_at` | `timestamptz` | — | the `first_order_at` floor this run selected against (previous run's `completed_at`, or `now − 8d` on first run) |
| `completed_at` | `timestamptz` | — | default `now()` — the timestamp the NEXT run reads as its watermark |
| `new_customers` | `integer` | — | default `0` — count of customers whose `first_order_at >= watermark_at` |
| `uploaded_rows` | `integer` | — | default `0` — sum of `num_received` across all `POST /{audience_id}/users` chunks for this run |
| `created_at` | `timestamptz` | — | default `now()` |

## Indexes

- `media_buyer_all_customers_refresh_runs_ws_audience_completed_at_idx` — `(workspace_id, audience_id, completed_at desc)` — the "last successful refresh per (workspace, audience)" lookup the cron does at the top of each run.

## RLS

- **Service role:** full access (`svc_all` — used by the cron).
- **Workspace members:** SELECT-only (`ws_member_read` — joins to `public.workspace_members` on `user_id = auth.uid()`), matching the sibling media-buyer ledger tables.

## Writer / reader

- **Writer:** [[../inngest/media-buyer-all-customers-refresh]] `media-buyer-all-customers-refresh-weekly` (INSERT at end of each successful group).
- **Reader:** the same cron on the following run (looks up the most recent `completed_at` per `(workspace_id, audience_id)` to pick the watermark).

## Migration

- **[[../specs/bianca-full-order-history-customer-list-exclusion-audience]] Fix 1:** `supabase/migrations/20261026130000_media_buyer_all_customers_refresh_runs.sql` — CREATE TABLE IF NOT EXISTS, RLS + policies inline. Idempotent (re-run = no-op).

## Related

[[workspaces]] · [[meta_ad_accounts]] · [[media_buyer_test_cohorts]] · [[../libraries/meta-ads]] · [[../inngest/media-buyer-all-customers-refresh]]
