# crisis_customer_actions

Per-customer state in a crisis campaign — segment, current tier, responses, swap/pause/remove actions. See [[../lifecycles/crisis-campaign]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `crisis_id` | `uuid` | — | → [[crisis_events]].id |
| `workspace_id` | `uuid` | — |  |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `segment` | `text` | — |  |
| `original_item` | `jsonb` | ✓ |  |
| `current_tier` | `int4` | ✓ | default: `0` |
| `tier1_sent_at` | `timestamptz` | ✓ |  |
| `tier1_response` | `text` | ✓ |  |
| `tier1_swapped_to` | `jsonb` | ✓ |  |
| `tier2_sent_at` | `timestamptz` | ✓ |  |
| `tier2_response` | `text` | ✓ |  |
| `tier2_swapped_to` | `jsonb` | ✓ |  |
| `tier2_coupon_applied` | `bool` | ✓ | default: `false` |
| `tier3_sent_at` | `timestamptz` | ✓ |  |
| `tier3_response` | `text` | ✓ |  |
| `paused_at` | `timestamptz` | ✓ |  |
| `auto_resume` | `bool` | ✓ | default: `false` |
| `removed_item_at` | `timestamptz` | ✓ |  |
| `auto_readd` | `bool` | ✓ | default: `false` |
| `cancelled` | `bool` | ✓ | default: `false` |
| `cancel_date` | `timestamptz` | ✓ |  |
| `ticket_id` | `uuid` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `exhausted_at` | `timestamptz` | ✓ |  |
| `preserved_base_price_cents` | `int4` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `crisis_id` → [[crisis_events]].`id`
- `customer_id` → [[customers]].`id`
- `subscription_id` → [[subscriptions]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("crisis_customer_actions")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("crisis_customer_actions")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Rows for a ticket
```ts
const { data } = await admin.from("crisis_customer_actions")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("crisis_customer_actions")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- `subscription_id` is the **internal UUID**, not `shopify_contract_id`. See feedback_crisis_action_subscription_id.
- Tier progression is monotonic: 0 → 1 → 2 → 3. Tier 3 outcomes diverge by segment (`berry_only` pauses, `berry_plus` removes item).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
