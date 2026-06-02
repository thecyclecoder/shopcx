# libraries/shortlink-slug

Customer short_code generator (Crockford base32, 6 chars).

**File:** `src/lib/shortlink-slug.ts`

## File header

```
Shortlink slug generator. Crockford-base32 alphabet (no 0/O/1/I/L/U
ambiguity), 6 chars. ~1 billion namespace per workspace; collisions
caught by the unique constraint on (workspace_id, slug) — caller
should retry on the rare hit.
```

## Exports

### `generateShortlinkSlug` — function

```ts
function generateShortlinkSlug(length = 6) : string
```

## Callers

- `src/lib/inngest/marketing-text.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
