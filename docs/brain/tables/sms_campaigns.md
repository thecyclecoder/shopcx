# sms_campaigns

SMS campaign — message body, MMS image, send_date, target_local_hour, audience filter, coupon config, shortlink target.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `status` | `text` | — | default: `'draft'` |
| `message_body` | `text` | — |  |
| `media_url` | `text` | ✓ |  |
| `send_date` | `date` | — |  |
| `target_local_hour` | `int4` | — | default: `11` |
| `fallback_timezone` | `text` | — | default: `'America/Chicago'` |
| `audience_filter` | `jsonb` | — | default: `'{}'` |
| `recipients_total` | `int4` | — | default: `0` |
| `recipients_sent` | `int4` | — | default: `0` |
| `recipients_delivered` | `int4` | — | default: `0` — running count of terminal-delivered recipients. Recounted by [[../inngest/sms-callback-drain]] every drain batch (not increment — idempotent across re-delivered callbacks). Added in [[../specs/twilio-callback-queue-drain]] Phase 4. |
| `recipients_failed` | `int4` | — | default: `0` |
| `recipients_skipped` | `int4` | — | default: `0` |
| `scheduled_at` | `timestamptz` | ✓ |  |
| `first_send_at` | `timestamptz` | ✓ |  |
| `last_send_at` | `timestamptz` | ✓ |  |
| `completed_at` | `timestamptz` | ✓ |  |
| `created_by` | `uuid` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `coupon_enabled` | `bool` | — | default: `false` |
| `coupon_code` | `text` | ✓ |  |
| `coupon_discount_pct` | `int4` | ✓ |  |
| `coupon_expires_days_after_send` | `int4` | ✓ | default: `21` |
| `coupon_shopify_node_id` | `text` | ✓ |  |
| `coupon_created_at` | `timestamptz` | ✓ |  |
| `coupon_disabled_at` | `timestamptz` | ✓ |  |
| `shortlink_target_url` | `text` | ✓ |  |
| `shortlink_slug` | `text` | ✓ |  |
| `included_segments` | `text[]` | — | default: `ARRAY[]` |
| `excluded_segments` | `text[]` | — | default: `ARRAY[]` |
| `fallback_target_local_hour` | `int2` | ✓ | default: `10` |
| `target_local_minute` | `int4` | — | default: `0` |
| `fallback_target_local_minute` | `int4` | — | default: `0` |
| `audience_staged_at` | `timestamptz` | ✓ |  |
| `audience_promoted_at` | `timestamptz` | ✓ |  |
| `priority` | `int4` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[marketing_shortlinks]].`campaign_id`
- [[sms_campaign_recipients]].`campaign_id`
- [[sms_send_candidates]].`campaign_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("sms_campaigns")
  .select("id, name, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("sms_campaigns")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("sms_campaigns")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Message body supports `{coupon}` and `{shortlink}` placeholders — substituted at send time. Compose with `\n\n` block breaks, GSM-7 only — see [[../inngest/marketing-text]] § Message body formatting.
- Coupon code generated in Shopify at schedule time (format `MAY` + 4 base32 chars). For a pre-existing Shopify code (e.g. a manual VIP coupon), set `coupon_enabled=false` + `coupon_code` directly so nothing new is minted.
- Per-segment conversion from our own sends → [[../sms-segment-performance]].

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]] · [[../sms-segment-performance]]
