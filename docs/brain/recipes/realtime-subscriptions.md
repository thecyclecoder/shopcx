# recipes/realtime-subscriptions

**Push, don't poll.** How to give a browser live DB-fed updates over one WebSocket instead of a `setInterval` that hammers PostgREST. The pattern behind cutting the polling firehose Supabase flagged 2026-07-21.

Reference implementation: [[../tables/realtime_demo]] + `/dashboard/developer/realtime-test` (`RealtimeDemoPanel.tsx`). Existing production uses: live chat (`ticket_messages`, `src/app/widget/[workspaceId]/page.tsx`) and ticket presence (`src/components/ticket-presence.tsx`).

## When to use it

A dashboard view that currently polls (`setInterval(load, N)`) to stay fresh — build progress, box lanes, a chat, any "watch a row change" surface. Realtime replaces `O(viewers × pollrate)` steady load with `O(actual changes)`: an idle subscribed page costs ~nothing; a change appears in a few hundred ms. Auth happens ONCE at connect, not per poll (kills the `set_config` preamble tax).

**When NOT to:** aggregate/derived views (counts, rollups) that no single row-change maps to — keep those on a slow poll or a periodic refresh. And note Supabase "Postgres Changes" re-checks every change against every subscription's RLS + filter, so it has its own ceiling at very high subscription counts; for high-volume fan-out prefer Realtime **Broadcast** (explicit publish) over Postgres Changes.

## The three required pieces

1. **Table in the `supabase_realtime` publication.** Without it, a subscription silently gets nothing.
   ```sql
   alter publication supabase_realtime add table public.<t>;   -- guard with a pg_publication_tables not-exists check
   ```
2. **RLS SELECT policy for the viewer.** Realtime enforces RLS per-subscriber — the browser only receives rows it could `select`. (Replica identity default/PK is enough unless you need OLD values on UPDATE/DELETE, then `alter table … replica identity full`.)
3. **A client subscription** (browser anon client, `@/lib/supabase/client`):
   ```tsx
   const supabase = createClient();
   const channel = supabase
     .channel("my-view")
     .on("postgres_changes", { event: "*", schema: "public", table: "<t>", filter: `id=eq.${id}` },
        (payload) => applyChange(payload.new))
     .subscribe((status) => setLive(status === "SUBSCRIBED"));
   // cleanup: supabase.removeChannel(channel)
   ```
   Fetch an initial snapshot once (RLS-scoped `select`) so the view isn't empty before the first event; after that, never poll.

## Gotchas

- **⚠️ Authenticate the socket, or RLS silently drops every event.** Postgres Changes applies the table's RLS to EACH event, evaluated as the **role on the Realtime WebSocket** — which is `anon` by default for the browser client. If your SELECT policy needs `auth.uid()` (any workspace-scoped table), an `anon` socket is *subscribed* (green/`SUBSCRIBED`) but receives **zero events** — they're all filtered out. Symptom: the channel connects, nothing ever arrives, a refresh shows the change. Fix — hand the socket the user's JWT **before** subscribing:
  ```tsx
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) await supabase.realtime.setAuth(data.session.access_token);
  // ...then .channel(...).subscribe()
  ```
  The public `ticket_messages` widget doesn't need this because it relies on an explicit **`anon`** SELECT policy (`visibility = 'external'`); an authenticated dashboard view (realtime_demo, box session steps) MUST `setAuth`. This is NOT a replica-identity issue — `default(pk)` delivers the full NEW row fine; it's purely the socket's role vs the policy.
- **Realtime payloads can truncate large columns** — for a big body/jsonb, treat the event as a "something changed" signal and re-fetch the full row (the live-chat widget does exactly this).
- **The publication add is DDL** — it ships as a guarded migration, applied by the migration-drift reconciler like any other.
- **Filter server-side** (`filter: 'id=eq.…'`) so the subscriber isn't woken for every row in the table.

## Related

[[../tables/realtime_demo]] · [[../dashboard/realtime-test]] · [[../tables/ticket_messages]] · [[../libraries/pg-pool]] (server-side `pg_notify('spec_changed')` / LISTEN — the same push idea between box processes)
