# customer_demographics

Per-customer demographic enrichment (age band, household income band, etc.) from Census/Versium. End-to-end pipeline in [[../lifecycles/demographic-enrichment]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `customer_id` | `uuid` | — | → [[customers]].id |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `inferred_gender` | `text` | ✓ |  |
| `inferred_gender_conf` | `numeric` | ✓ |  |
| `inferred_age_range` | `text` | ✓ |  |
| `inferred_age_conf` | `numeric` | ✓ |  |
| `name_inference_notes` | `text` | ✓ |  |
| `zip_code` | `text` | ✓ |  |
| `zip_median_income` | `int4` | ✓ |  |
| `zip_median_age` | `numeric` | ✓ |  |
| `zip_income_bracket` | `text` | ✓ |  |
| `zip_urban_classification` | `text` | ✓ |  |
| `zip_owner_pct` | `numeric` | ✓ |  |
| `zip_college_pct` | `numeric` | ✓ |  |
| `inferred_life_stage` | `text` | ✓ |  |
| `health_priorities` | `text[]` | ✓ | default: `'{}'` |
| `buyer_type` | `text` | ✓ |  |
| `total_orders` | `int4` | ✓ | default: `0` |
| `total_spend_cents` | `int4` | ✓ | default: `0` |
| `subscription_tenure_days` | `int4` | ✓ | default: `0` |
| `enriched_at` | `timestamptz` | — | default: `now()` |
| `enrichment_version` | `int4` | — | default: `1` |
| `census_data_year` | `int4` | ✓ |  |
| `versium_gender` | `text` | ✓ |  |
| `versium_age_range` | `text` | ✓ |  |
| `versium_household_income` | `text` | ✓ |  |
| `versium_net_worth` | `text` | ✓ |  |
| `versium_education` | `text` | ✓ |  |
| `versium_marital_status` | `text` | ✓ |  |
| `versium_home_owner` | `bool` | ✓ |  |
| `versium_home_value` | `text` | ✓ |  |
| `versium_household_size` | `text` | ✓ |  |
| `versium_presence_of_children` | `text` | ✓ |  |
| `versium_interests` | `text[]` | ✓ | default: `'{}'` |
| `versium_raw` | `jsonb` | ✓ |  |
| `versium_enriched_at` | `timestamptz` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("customer_demographics")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("customer_demographics")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
