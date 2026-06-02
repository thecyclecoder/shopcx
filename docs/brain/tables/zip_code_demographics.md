# zip_code_demographics

US zip code demographic reference data (income, age distribution) for customer enrichment.

**Primary key:** `zip_code`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `zip_code` | `text` | — |  |
| `median_income` | `int4` | ✓ |  |
| `median_age` | `numeric` | ✓ |  |
| `owner_pct` | `numeric` | ✓ |  |
| `college_pct` | `numeric` | ✓ |  |
| `population` | `int4` | ✓ |  |
| `population_density` | `numeric` | ✓ |  |
| `urban_classification` | `text` | ✓ |  |
| `income_bracket` | `text` | ✓ |  |
| `state` | `text` | ✓ |  |
| `fetched_at` | `timestamptz` | — | default: `now()` |
| `acs_year` | `int4` | ✓ |  |

## Foreign keys

**Out (this → others):**

_None._

**In (others → this):**

_None._

## Common queries

### Read all rows (small reference table)
```ts
const { data } = await admin.from("zip_code_demographics").select("*");
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
