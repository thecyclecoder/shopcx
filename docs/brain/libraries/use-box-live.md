# libraries/use-box-live

`src/lib/use-box-live.ts` — a React hook that subscribes a roadmap/box dashboard component to live changes over Realtime **Broadcast**, replacing a `setInterval` poll. `roadmap-box-broadcast`.

```ts
useBoxLive(refetch: () => void, opts?: { backstopMs?: number; enabled?: boolean }): void
```

On each broadcast (or on the slow backstop / tab-return) it calls `refetch()`. Push, not poll: an idle page costs ~nothing and updates the instant a job/heartbeat/chat changes, instead of hammering `/api/roadmap/box` every few seconds.

## How it works

- Subscribes to the **private** per-workspace topic **`box:<workspace_id>`** (`workspace.id` from [[workspace-context|useWorkspace]]). `setAuth(session.access_token)` runs **before** subscribe so the private channel join is authorized by the `realtime.messages` `box_broadcast_read` policy.
- On a `box_change` broadcast it calls `refetch` — **debounced ~300ms** so a burst of `session_checklist` writes during a live build collapses into ONE refetch. The pages re-hit their existing `/api/*` endpoint for enriched data (broadcast is a "something changed" signal, not the data itself — same as the live-chat widget).
- **Backstop:** a slow `setInterval(refetch, backstopMs)` (default 30s — vs the 4–10s poll it replaces) + a refetch on tab-return. Broadcast is fire-and-forget (a NOTIFY missed while the socket reconnects is lost), so the backstop guarantees the page is at worst `backstopMs` stale, never stuck.
- `enabled: false` skips the subscription + backstop entirely (used by `PlanButton`/`BuildButton`, which only watch while their job is active).

## The topic's producers

Three DB triggers ([[../tables/agent_jobs]], [[../tables/worker_heartbeats]], [[../tables/roadmap_chats]] — migration `20261203120000`) all `realtime.send(..., 'box_change', 'box:<ws>', private)`, so one hook + one topic covers the whole DevOps live surface. See [[../dashboard/roadmap__box]] + [[../recipes/realtime-subscriptions]].

## Consumers

- [[../dashboard/roadmap__box]] box page — `useBoxLive(load, { backstopMs: 30_000 })` (was a 5s poll).
- `BoxChip` (roadmap board header) — `useBoxLive(load, { backstopMs: 60_000 })` (was a 10s poll).
- `PlanButton` / `BuildButton` — `useBoxLive(poll, { enabled: active, backstopMs: 10_000 })` (was a 4s poll while the job is active).
- `AuthoringChat` — `useBoxLive(tick, { enabled: chatActive, backstopMs: 3_000 })` (was a 3s poll while a turn is on the box; `roadmap_chats` writes now push the turn-complete instantly).

## Related

[[../recipes/realtime-subscriptions]] · [[../tables/agent_jobs]] · [[../tables/worker_heartbeats]] · [[../tables/roadmap_chats]] · [[pg-pool]] (the server-side `LISTEN`/`NOTIFY` cousin for the box worker)
