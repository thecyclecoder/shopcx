# meta_webhook_raw

Raw Meta webhook bodies for debugging.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `int8` | — |  |
| `received_at` | `timestamptz` | — | default: `now()` |
| `signature_valid` | `bool` | ✓ |  |
| `body` | `jsonb` | — |  |
| `headers` | `jsonb` | ✓ |  |

## Foreign keys

**Out (this → others):**

_None._

**In (others → this):**

_None._

## Common queries

### Read all rows (small reference table)
```ts
const { data } = await admin.from("meta_webhook_raw").select("*");
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
