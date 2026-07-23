# recipes/realtime-subscriptions

**Push, don't poll.** How to give a browser live DB-fed updates over one WebSocket instead of a `setInterval` that hammers PostgREST. The pattern behind cutting the polling firehose Supabase flagged 2026-07-21.

Reference implementation: [[../tables/realtime_demo]] + `/dashboard/developer/realtime-test` (`RealtimeDemoPanel.tsx`).

## ⭐ Use Broadcast, not Postgres Changes

Supabase Realtime has two ways to stream DB changes to a browser. **Prefer Broadcast.**

| | **Broadcast** (recommended) | **Postgres Changes** (avoid for RLS tables) |
|---|---|---|
| Mechanism | A table trigger calls `realtime.broadcast_changes()` → sends to a topic | Realtime tails the WAL via the `supabase_realtime` publication |
| Authorization | Channel-level: one RLS policy on `realtime.messages`, gated by **topic** | Per-row RLS re-checked on every event by the "Walrus" engine |
| Reliability | Works. Verified end-to-end 2026-07-23. | **Buggy on RLS tables** — INSERT/UPDATE events get silently filtered while DELETE leaks through (open Supabase bugs [realtime#213](https://github.com/supabase/realtime/issues/213), [supabase#29542](https://github.com/supabase/supabase/issues/29542)). We burned hours on this; do not repeat. |
| Scaling | Supabase's own recommended path | Re-checks every change against every subscription — ceiling at high subscription counts |

The one live Postgres-Changes user we have is the public `ticket_messages` widget, and it only works because it subscribes to **INSERT** (never hits the UPDATE/DELETE RLS bug) with an explicit **`anon`** SELECT policy. For anything authenticated or that needs UPDATE/DELETE, use Broadcast.

## Broadcast — the three pieces

1. **A trigger that broadcasts the change** (sends on a PRIVATE topic):
   ```sql
   create or replace function public.<t>_broadcast() returns trigger
   language plpgsql security definer as $$
   begin
     perform realtime.broadcast_changes(
       '<topic>',            -- channel the browser subscribes to
       'db_change',          -- event name the browser filters on
       tg_op, tg_table_name, tg_table_schema,
       new,                  -- payload.record   (null on DELETE)
       old                   -- payload.old_record (null on INSERT)
     );
     return null;
   end $$;
   create trigger <t>_broadcast_trg after insert or update or delete on public.<t>
     for each row execute function public.<t>_broadcast();
   ```
2. **An RLS policy on `realtime.messages`** authorizing SELECT (receive) for the topic:
   ```sql
   create policy <t>_broadcast_read on realtime.messages
     for select using ((select realtime.topic()) = '<topic>');
   -- For a workspace-scoped view, AND a membership check here (topic carries the id, or check claims).
   ```
3. **The browser subscribes to a PRIVATE channel**, with `setAuth` before subscribe (private channels require the socket to carry the user's JWT):
   ```tsx
   const supabase = createClient();
   const { data } = await supabase.auth.getSession();
   if (data.session?.access_token) await supabase.realtime.setAuth(data.session.access_token);
   const channel = supabase
     .channel("<topic>", { config: { private: true } })
     .on("broadcast", { event: "db_change" }, (msg) => {
       const p = msg.payload;         // { operation, record, old_record, table, schema }
       applyChange(p.operation, p.record ?? p.old_record);
     })
     .subscribe((status) => setLive(status === "SUBSCRIBED"));
   // cleanup: supabase.removeChannel(channel)
   ```
   Fetch the initial snapshot once **via a server `/api/*` route** (this app reads data server-side; a browser-side `.from().select()` fails with no `apikey`). After that, never poll — updates arrive over the channel.

## When to use it / when not

Use it for a view that currently polls to watch rows change — build progress, box lanes, a chat. Broadcast replaces `O(viewers × pollrate)` steady load with `O(actual changes)`: an idle subscribed page costs ~nothing, and auth happens ONCE at connect, not per poll. **Not** for aggregate/derived views (counts, rollups) no single row maps to — keep those on a slow poll.

## Gotchas (each cost real time to learn)

- **`realtime.broadcast_changes` sends PRIVATE.** A public channel (`private: false`) receives nothing. Always `config: { private: true }` + `setAuth` + the `realtime.messages` policy.
- **`setAuth` before `subscribe`**, or the private-channel join isn't authorized.
- **Postgres Changes ≠ Broadcast.** If you (or a tutorial) reach for `.on("postgres_changes", …)`, stop — that's the buggy path. See the table above.
- **Enabling Postgres Changes needs a Realtime reload** (if you ever must use it): `ALTER PUBLICATION supabase_realtime ADD TABLE` alone isn't enough — the Realtime service caches its table set; toggle the table in Dashboard → Publications. Broadcast avoids this entirely (no publication involved).
- **Initial snapshot goes through a server route**, not a browser `.from().select()` — the browser Supabase client here is Realtime-only.

## Server-side push (the cousin)

For **process-to-process** eventing (not browser) — e.g. the box worker reacting to a DB change — use raw Postgres `LISTEN`/`NOTIFY`, not Realtime. See [[../libraries/pg-pool]] `startAgentJobQueuedListener` (event-driven box claims) + [[../tables/agent_jobs]] `agent_job_queued_notify_trg`. **Key gotcha:** `LISTEN`/`NOTIFY` is NOT delivered by the transaction pooler (`:6543`) — the listener must connect via the **session pooler (`:5432`)**.

## Related

[[../tables/realtime_demo]] · [[../dashboard/realtime-test]] · [[../tables/ticket_messages]] · [[../libraries/pg-pool]]
