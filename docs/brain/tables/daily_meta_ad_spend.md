# daily_meta_ad_spend

Per-(account, day) Meta Ads spend rollup for ROAS dashboard.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id |
| `snapshot_date` | `date` | — |  |
| `spend_cents` | `int4` | — | default: `0` |
| `impressions` | `int4` | — | default: `0` |
| `clicks` | `int4` | — | default: `0` |
| `purchases` | `int4` | — | default: `0` |
| `purchase_value_cents` | `int4` | — | default: `0` |
| `currency` | `text` | — | default: `'USD'` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `meta_ad_account_id` → [[meta_ad_accounts]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("daily_meta_ad_spend")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("daily_meta_ad_spend")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- **Generator gap — this table is written by two Inngest functions whose brain pages don't list it.** `syncMetaAdSpend` (`src/lib/meta/sync-spend.ts`) writes rows here, and it's called by both [[../inngest/meta-sync]] `meta/sync-spend` and [[../inngest/today-sync]] `today-sync` (5-min cron). Both those generated pages currently claim `Tables written: _None._` because the brain generator doesn't follow the `syncMetaAdSpend → daily_meta_ad_spend` transitive write. Noted here (per [[../specs/meta-reconnect-required-class]] Phase 4) so the next reader tracing provenance from this table's data lands on the right functions rather than the empty tables-written line. If the generator gains transitive-write following, drop this bullet.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
