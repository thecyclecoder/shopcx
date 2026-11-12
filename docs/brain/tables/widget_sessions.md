# widget_sessions

Per-visitor chat-widget session state (anonymous chat tickets begin here).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `email` | `text` | ✓ |  |
| `name` | `text` | ✓ |  |
| `created_at` | `timestamptz` | ✓ | default: `now()` |
| `last_activity_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("widget_sessions")
  .select("id, name, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("widget_sessions")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Rows for a ticket
```ts
const { data } = await admin.from("widget_sessions")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("widget_sessions")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- **A session id IS the proof of chat ownership — never list a shopper's chats by email alone.** `GET /api/widget/{workspaceId}/chats` (`src/app/api/widget/[workspaceId]/chats/route.ts`) only returns tickets for `widget_sessions` ids the caller passes as `?session_id=` (repeatable / comma-separated) — the ids the iframe stored in `localStorage` (`shopcx_chat_sessions_{workspaceId}`) when it created them. An email-only request returns `{ chats: [] }` (not an error, so stale cached widget bundles degrade quietly to "no past chats"). This closes a read-by-email hole: `/api/widget/*` sends `Access-Control-Allow-Origin: *` (`src/proxy.ts`), so anyone who knew a shopper's email could previously list their chats cross-origin and, through the session, read the conversation. Treat the `id` like a bearer token — it is unguessable (`gen_random_uuid()`) and possession of it is the authorization. A verified identity pass (widget-signed-identity-pass, once shipped) is the only other acceptable proof for listing by store/email.

_Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
