# tables/realtime_demo

A tiny, self-contained table for **verifying Supabase Realtime end-to-end** — DB write → trigger → Realtime **Broadcast** → browser subscription → live UI, with zero polling. Demonstration only; NOT wired to any production flow.

> **Uses Broadcast, not Postgres Changes.** The demo originally used Postgres Changes and hit the open Supabase RLS/Walrus bug (INSERT/UPDATE events silently dropped, only DELETE delivered). It now uses Broadcast — a trigger calls `realtime.broadcast_changes()` to a private topic, the browser subscribes to that topic. Verified end-to-end 2026-07-23. See [[../recipes/realtime-subscriptions]] for the full why.

**Migrations:** `20261129120000_realtime_demo_table.sql` (table + RLS) · `20261202120000_realtime_demo_broadcast.sql` (broadcast trigger + `realtime.messages` policy; apply `scripts/apply-realtime-demo-broadcast-migration.ts`) · **surface:** [[../dashboard/realtime-test]] (`/dashboard/developer/realtime-test`) · **pattern:** [[../recipes/realtime-subscriptions]]

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

## Realtime wiring (the point of the table) — Broadcast

- **Trigger `realtime_demo_broadcast_trg`** (`20261202120000`) — an AFTER INSERT/UPDATE/DELETE trigger that calls `realtime.broadcast_changes('realtime_demo', 'db_change', tg_op, …, new, old)`, pushing each change to the PRIVATE `realtime_demo` topic. No publication, no WAL, no replica identity, no per-row RLS — this is why it avoids the Postgres-Changes/Walrus bug.
- **`realtime.messages` RLS** — `realtime_demo_broadcast_read` authorizes SELECT (receive) on the `realtime_demo` topic. Broadcast authorization is channel-level (by topic), not per-row.
- **Browser subscribes to a private channel** — `supabase.channel('realtime_demo', { config: { private: true } })` with `setAuth(jwt)` before subscribe. Payload shape: `{ operation, record (new), old_record (old), table, schema }`.

The table's own `realtime_demo_select` RLS (below) no longer gates the live path — the initial snapshot comes from the server route `/api/developer/realtime-demo` (admin, bypasses RLS), and Broadcast delivery is gated by the `realtime.messages` policy, not `realtime_demo`'s.

## RLS

- `realtime_demo_select` — `for select using (workspace_id in (select workspace_id from workspace_members where user_id = auth.uid()))`.
- `realtime_demo_service` — `for all` to service_role.

## How to test

1. Open `/dashboard/developer/realtime-test` (panel subscribes, shows a green "Live" dot).
2. Run `npx tsx scripts/_bump-realtime-demo.ts "hello"` (service-role UPDATE, bumps `tick`, sets `note`).
3. The row + event log update on the open page with no refresh, within a few hundred ms.

## Related

[[../recipes/realtime-subscriptions]] · [[../dashboard/realtime-test]] · [[../libraries/pg-pool]] (the server-side `pg_notify`/LISTEN push cousin) · [[../tables/ticket_messages]] (the one live Postgres-Changes user — INSERT-only + anon policy)
