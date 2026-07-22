# tables/realtime_demo

A tiny, self-contained table for **verifying Supabase Realtime (Postgres Changes) end-to-end** — DB write → WAL → Realtime → browser subscription → live UI, with zero polling. Demonstration only; NOT wired to any production flow.

**Migration:** `supabase/migrations/20261129120000_realtime_demo_table.sql` (apply `scripts/apply-realtime-demo-migration.ts`) · **surface:** [[../dashboard/realtime-test]] (`/dashboard/developer/realtime-test`) · **pattern:** [[../recipes/realtime-subscriptions]]

## Why it exists

Browser-driven **polling** against the DB is the load pattern behind Supabase's 2026-07-21 pooler alert: `tabs × components × (1/interval)` requests fire whether or not anything changed, each re-establishing auth (the `set_config` preamble). The push alternative is Supabase Realtime — the browser holds ONE authenticated WebSocket and the server pushes a row event only when the table actually changes. This table is the proving ground for that pattern before adopting it on real live views (box session steps, roadmap board). Its whole job is: a service-role write here appears in an open dashboard within a few hundred ms, no refresh.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` ON DELETE CASCADE; RLS scopes reads to members |
| `label` | `text` | free label, default `'demo'` |
| `tick` | `integer` | bumped by `scripts/_bump-realtime-demo.ts` to trigger a visible change |
| `note` | `text?` | last-change note |
| `updated_at` | `timestamptz` | stamped on each bump |

## Realtime wiring (the point of the table)

- **In the `supabase_realtime` publication** — `alter publication supabase_realtime add table public.realtime_demo` (guarded). This is REQUIRED for Postgres Changes; a subscription on a table NOT in the publication silently receives nothing. Before this table, only `ticket_messages` was in the publication (live chat).
- **Replica identity: default (PK)** — sufficient here. INSERT/UPDATE events carry the full NEW row (all the panel renders). FULL replica identity is only needed to receive OLD values on UPDATE/DELETE, which this demo doesn't use.
- **RLS is enforced per-subscriber.** Realtime checks the subscriber against `realtime_demo_select` (workspace members) before delivering, so a browser only receives its own workspace's changes — same policy that gates a plain `select`.

## RLS

- `realtime_demo_select` — `for select using (workspace_id in (select workspace_id from workspace_members where user_id = auth.uid()))`.
- `realtime_demo_service` — `for all` to service_role.

## How to test

1. Open `/dashboard/developer/realtime-test` (panel subscribes, shows a green "Live" dot).
2. Run `npx tsx scripts/_bump-realtime-demo.ts "hello"` (service-role UPDATE, bumps `tick`, sets `note`).
3. The row + event log update on the open page with no refresh, within a few hundred ms.

## Related

[[../recipes/realtime-subscriptions]] · [[../dashboard/realtime-test]] · [[../libraries/pg-pool]] (the server-side `pg_notify`/LISTEN push cousin) · [[../tables/ticket_messages]] (the other publication member)
