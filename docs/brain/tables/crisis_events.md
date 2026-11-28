# crisis_events

Crisis campaigns (e.g. Mixed Berry OOS) — affected variant, swap options, tiers, coupon. See [[../lifecycles/crisis-campaign]]. Writes go through [[../libraries/crisis-events]] (`createCrisisEvent` / `activateCrisisEvent`).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `status` | `text` | — | default: `'draft'` |
| `affected_variant_id` | `text` | — |  |
| `affected_sku` | `text` | ✓ |  |
| `affected_product_title` | `text` | ✓ |  |
| `default_swap_variant_id` | `text` | ✓ |  |
| `default_swap_title` | `text` | ✓ |  |
| `available_flavor_swaps` | `jsonb` | ✓ | default: `'[]'` |
| `available_product_swaps` | `jsonb` | ✓ | default: `'[]'` |
| `tier2_coupon_code` | `text` | ✓ |  |
| `tier2_coupon_percent` | `int4` | ✓ | default: `20` |
| `expected_restock_date` | `date` | ✓ |  |
| `lead_time_days` | `int4` | ✓ | default: `7` |
| `tier_wait_days` | `int4` | ✓ | default: `3` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[crisis_customer_actions]].`crisis_id`
- [[knowledge_base]].`crisis_id`
- [[macros]].`crisis_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("crisis_events")
  .select("id, name, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("crisis_events")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("crisis_events")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Substitution behavior — the order row is NOT what shipped during a crisis

While a crisis is **active**, Amplifier ships the affected (out-of-stock) SKU as an **alternative
flavor** — the crisis's `default_swap_title` / `default_swap_variant_id`. But `orders.line_items`
still records the **ordered** variant, so a line showing "Cocoa shipped" is the ordered flavor, NOT
what the warehouse actually put in the box.

The [[../libraries/crisis-substitution]] helper flags these lines: a line is `likely_substituted`
when its `variant_id`/`sku` matches a crisis's `affected_variant_id`/`affected_sku`, the crisis
covered the ship (status `active`, or `resolved` on/after `orders.amplifier_shipped_at`), and the
order shipped on or after the crisis's `created_at`. The likely-shipped flavor is `default_swap_title`.
Sol's order context (`getCustomerAccount`) and June's ground-truth / `remedy_state` brief
(`getCxOrders` / `formatCxOrders`) both surface a `[LIKELY SHIPPED AS <flavor> — crisis substitution]`
note on such a line.

**Rule for June + Sol:** a customer's wrong-flavor report on a `likely_substituted` line is TRUE —
it is OUR fault (the substitution), never a false claim. Do not cite the order row to deny it; handle
it on the crisis white-glove path. Ground truth: Yukiko Ban (tickets e159a032 / 3488aabf) — June
ruled her Hazelnut-for-Cocoa report false three times because the order row said Cocoa.

## Gotchas

- **The ordered variant on `orders.line_items` is not the shipped flavor during a crisis** — see
  the Substitution behavior section above. Read `likely_substituted` (via
  [[../libraries/crisis-substitution]]), never the raw order line, as ground truth for what shipped.
- **Validate `crisisId` before querying — `undefined` serializes into a Postgres uuid-cast error.** 
  When a `crisisId` is passed as metadata (e.g., from journey completion in `src/app/api/journey/[token]/complete/route.ts` 
  `sendCrisisConfirmation`), always validate it is a string matching the UUID regex 
  `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` BEFORE calling `.eq('id', crisisId)`. 
  If the guard fails, skip the lookup and use fallbacks (e.g., `restockDate='soon'`, `affectedItem='your item'`). 
  An unguarded `.eq('id', undefined)` serializes `undefined` into the query string, producing `WHERE id = 'undefined'` 
  — Postgres rejects this with a uuid-cast error on every attempt. The guard lives in the journey-complete route 
  (`sendCrisisConfirmation`, ~line 1414-1425).
- Probe before assuming — see [[../README]] § Probing technique.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
