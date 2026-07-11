# ticket_messages

Messages on a ticket. direction (in/out), visibility (public/internal), author_type (customer/agent/ai/system).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `ticket_id` | `uuid` | — | → [[tickets]].id |
| `direction` | `text` | — |  |
| `visibility` | `text` | — | default: `'external'` |
| `author_type` | `text` | — |  |
| `author_id` | `uuid` | ✓ |  |
| `body` | `text` | — |  |
| `email_message_id` | `text` | ✓ |  |
| `ai_draft` | `bool` | — | default: `false` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `macro_id` | `uuid` | ✓ | → [[macros]].id |
| `ai_personalized` | `bool` | ✓ | default: `false` |
| `meta_message_id` | `text` | ✓ |  |
| `body_clean` | `text` | ✓ |  |
| `pending_send_at` | `timestamptz` | ✓ |  |
| `sent_at` | `timestamptz` | ✓ |  |
| `send_cancelled` | `bool` | ✓ | default: `false` |
| `resend_email_id` | `text` | ✓ |  |
| `email_status` | `text` | ✓ |  |
| `is_ai_guidance` | `bool` | — | default: `false` |
| `dispatch_pending_at` | `timestamptz` | ✓ | Phase 2 of [[../specs/durable-inbound-dispatch-no-silently-lost-ticket-event]] |

## Foreign keys

**Out (this → others):**

- `macro_id` → [[macros]].`id`
- `ticket_id` → [[tickets]].`id`

**In (others → this):**

- [[macro_usage_log]].`message_id`

## Common queries

### Full conversation transcript (for AI prompts)
```ts
const { data: msgs } = await admin.from("ticket_messages")
  .select("direction, visibility, author_type, body, body_clean, created_at")
  .eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
// Use body_clean for AI; body for verbatim display.
```

### Find the inbound email message that started a ticket
```ts
const { data } = await admin.from("ticket_messages")
  .select("email_message_id, body_clean, created_at")
  .eq("ticket_id", ticketId)
  .eq("direction", "inbound")
  .eq("author_type", "customer")
  .order("created_at", { ascending: true }).limit(1).maybeSingle();
```

### Check whether an inbound message just landed
```ts
const { data } = await admin.from("ticket_messages")
  .select("id")
  .eq("ticket_id", ticketId)
  .eq("direction", "inbound")
  .gt("created_at", since);
```

### Outbound resend ids for tracking joins
```ts
const { data } = await admin.from("ticket_messages")
  .select("id, resend_email_id, created_at")
  .eq("ticket_id", ticketId)
  .eq("direction", "outbound")
  .not("resend_email_id", "is", null);
```

## Gotchas

- Not workspace-scoped — keyed by `ticket_id`. Workspace comes via the parent ticket.
- Body field is `body_clean` (cleaned for AI prompts) and `body` (verbatim). Not `clean_body` / `cleaned_body`.
- `resend_email_id` not `resend_id`. supabase-js will silently insert with unknown columns dropped — always check `error` on insert.
- `author_type`: `"customer"`, `"agent"`, `"ai"`, `"system"`.
- `direction`: `"inbound"`, `"outbound"`.
- `visibility`: **`"external"`** (customer-facing, default) and **`"internal"`** (notes only). NOT `"public"` — earlier docs were wrong. Querying `.eq("visibility", "public")` returns zero rows.
- `author_id` is usually NULL for `customer`, `ai`, and `system` author types; only `agent` rows reliably have it set (the user UUID of the operator).
- `transactions.type` is open-ended (only `initial_checkout` in prod so far); `transactions.status` is `"succeeded"` (NOT `"settled"`).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
