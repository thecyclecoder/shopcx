# sms_marketing_inbound

Inbound SMS replies / STOP / HELP messages.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | ✓ | → [[workspaces]].id |
| `shortcode` | `text` | — |  |
| `from_phone` | `text` | — |  |
| `body` | `text` | ✓ |  |
| `message_sid` | `text` | ✓ |  |
| `autoresponded` | `bool` | — | default: `false` · Set to `true` after sending a generic-reply autoresponse (24h dedupe window, one autoresponse per shortcode + phone pair). STOP/START confirmations come from Twilio's Advanced Opt-Out at the carrier edge (no autoresponse needed). See [[../inngest/sms-callback-drain]] § `sms-inbound-drain`. |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("sms_marketing_inbound")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("sms_marketing_inbound")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- **Inbound processing is off the webhook request path** — `POST /api/webhooks/twilio/marketing-sms` enqueues a single `sms/inbound.received` Inngest event; the drain consumer ([[../inngest/sms-callback-drain]] `sms-inbound-drain`) handles STOP/START/reply logic asynchronously, writing this table. The webhook returns 200 immediately. Part of the twilio-callback-queue-drain feature (archived 2026-07-04).
- **STOP/START confirmations are sent by Twilio** — Advanced Opt-Out at the carrier edge; the drain does not send a reply for STOP/START. Generic-reply autoresponses are sent asynchronously from the drain via `sendSMS()` (out-of-band from the request path) and deduplicated by `(shortcode, from_phone)` in a 24h window.

## Related

[[../inngest/sms-callback-drain]] · [[../integrations/twilio]]

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
