# sms_campaign_recipients

Per-recipient SMS send row — local-time-resolved `send_time`, status, message_sid. See [[../tables/sms_campaigns]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — |  |
| `campaign_id` | `uuid` | — | → [[sms_campaigns]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `phone` | `text` | — |  |
| `resolved_timezone` | `text` | — |  |
| `timezone_source` | `text` | — |  |
| `scheduled_send_at` | `timestamptz` | — |  |
| `status` | `text` | — | default: `'pending'` |
| `message_sid` | `text` | ✓ |  |
| `sent_at` | `timestamptz` | ✓ |  |
| `delivered_at` | `timestamptz` | ✓ |  |
| `error` | `text` | ✓ |  |
| `shortlink_slug` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `scheduled_at_twilio` | `timestamptz` | ✓ |  |
| `preferred_hour_used` | `int2` | ✓ |  |
| `received_sms_logged_at` | `timestamptz` | ✓ | Set once the recipient's terminal-delivered state has been rolled up into `profile_events` (`metric_name='Received SMS'`). Idempotency flag for the [[../inngest/sms-callback-drain]] `received-sms-rollup-cron` (Phase 4 of [[../specs/twilio-callback-queue-drain]]). Candidate set = `delivered_at IS NOT NULL AND received_sms_logged_at IS NULL`, backed by partial index `idx_sms_campaign_recipients_rollup_pending`. |

## Foreign keys

**Out (this → others):**

- `campaign_id` → [[sms_campaigns]].`id`
- `customer_id` → [[customers]].`id`

**In (others → this):**

- [[marketing_shortlink_clicks]].`recipient_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("sms_campaign_recipients")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("sms_campaign_recipients")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("sms_campaign_recipients")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("sms_campaign_recipients")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- `send_time` is **per-recipient local time** — resolved through customer tz → shipping zip → area code → workspace fallback chain.
- Status: `pending` / `sent` / `skipped` / `failed`.
- Missing index on `message_sid` was the cause of past DB lockups. See project_db_lockup_diagnosis.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
