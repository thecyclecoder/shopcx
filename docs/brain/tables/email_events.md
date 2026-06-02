# email_events

Universal email tracking — sent, delivered, opened, clicked, bounced. Joined by `resend_email_id`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `resend_email_id` | `text` | — |  |
| `event_type` | `text` | — |  |
| `occurred_at` | `timestamptz` | — |  |
| `recipient_email` | `text` | ✓ |  |
| `subject` | `text` | ✓ |  |
| `metadata` | `jsonb` | ✓ | default: `'{}'` |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `created_at` | `timestamptz` | — | default: `now()` |

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
const { data } = await admin.from("email_events")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("email_events")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Rows for a ticket
```ts
const { data } = await admin.from("email_events")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("email_events")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Join key: `resend_email_id` (the Resend outbound id). Inbound emails don't have one.
- Event types: `sent`, `delivered`, `opened`, `clicked`, `bounced`. Open + click tracked via self-hosted pixel + redirect, not Resend's tracking.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
