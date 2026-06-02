# loyalty_redemptions

Points redemption events — coupon issued, used, expired.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `member_id` | `uuid` | — | → [[loyalty_members]].id |
| `reward_tier` | `text` | — |  |
| `points_spent` | `int4` | — |  |
| `discount_code` | `text` | — |  |
| `shopify_discount_id` | `text` | ✓ |  |
| `discount_value` | `numeric` | — |  |
| `status` | `text` | — | default: `'active'` |
| `used_at` | `timestamptz` | ✓ |  |
| `expires_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `member_id` → [[loyalty_members]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("loyalty_redemptions")
  .select("id, status, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("loyalty_redemptions")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("loyalty_redemptions")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
