# dashboard/realtime-test

`/dashboard/developer/realtime-test` — a live verification of Supabase Realtime (Postgres Changes). Proves the push-not-poll pattern before it's adopted on real live views.

**Files:** `src/app/dashboard/developer/realtime-test/page.tsx` (thin client wrapper) + `RealtimeDemoPanel.tsx` (the subscription) · **table:** [[../tables/realtime_demo]] · **pattern:** [[../recipes/realtime-subscriptions]]

## What it shows

- A **connection dot** — green "Live — subscribed (no polling)" once the WebSocket is `SUBSCRIBED`.
- A **rows table** — every `realtime_demo` row (RLS-scoped), pushed live.
- An **event log** — each INSERT/UPDATE/DELETE as it arrives, newest first.

The panel fetches ONE initial snapshot, then never polls — every subsequent update arrives over the subscription. No `setInterval`.

## How to demo

Open the page, then run `npx tsx scripts/_bump-realtime-demo.ts "note"` (service-role UPDATE). The row's `tick`/`note` and the event log update with no refresh. This is the end-to-end proof: a DB write reaches an open browser in a few hundred ms via push.

## Related

[[../tables/realtime_demo]] · [[../recipes/realtime-subscriptions]]
