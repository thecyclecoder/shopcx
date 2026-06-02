# known_resellers

Amazon resellers (sellerId + business name + address) used by the `amazon_reseller` fraud rule. See CLAUDE.md § Reseller Defense.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `platform` | `text` | — | default: `'amazon'` |
| `amazon_seller_id` | `text` | ✓ |  |
| `business_name` | `text` | ✓ |  |
| `address1` | `text` | ✓ |  |
| `address2` | `text` | ✓ |  |
| `city` | `text` | ✓ |  |
| `state` | `text` | ✓ |  |
| `zip` | `text` | ✓ |  |
| `country` | `text` | ✓ | default: `'US'` |
| `normalized_address` | `text` | ✓ |  |
| `source_asins` | `text[]` | ✓ | default: `'{}'` |
| `status` | `text` | — | default: `'active'` |
| `notes` | `text` | ✓ |  |
| `discovered_at` | `timestamptz` | — | default: `now()` |
| `last_seen_at` | `timestamptz` | — | default: `now()` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[fraud_action_log]].`reseller_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("known_resellers")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("known_resellers")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("known_resellers")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Default new entries to `status='active'` — there are no authorized resellers. See feedback_no_resellers_allowed.
- Address comparison is two-pass: exact normalized match, then Haiku fuzzy match when zip + street number agree.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
