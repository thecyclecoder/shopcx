# customer_links

Account-linking graph. Multiple `customer_id`s share a `group_id` = one real person.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `group_id` | `uuid` | — |  |
| `customer_id` | `uuid` | — | → [[customers]].id |
| `is_primary` | `bool` | — | default: `false` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### Get the group of linked customer ids for a customer
```ts
async function linkedIds(admin, customerId): Promise<string[]> {
  const { data: link } = await admin.from("customer_links")
    .select("group_id").eq("customer_id", customerId).maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: group } = await admin.from("customer_links")
    .select("customer_id").eq("group_id", link.group_id);
  return (group || []).map((r) => r.customer_id);
}
```

### Has this link already been rejected?
```ts
const { data } = await admin.from("customer_link_rejections")
  .select("id")
  .eq("customer_id", primary)
  .eq("rejected_customer_id", candidate).maybeSingle();
```

## Gotchas

- Linkage is via `group_id`. All customers in the same group are the same real person.
- Always expand to the group before scoping per-customer queries — see DATABASE.md `linkedIds()`.
- When suggesting links, check `customer_link_rejections` first — never re-offer a rejected link.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
