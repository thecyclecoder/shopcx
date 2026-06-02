# libraries/email-cleaner

Strip quoted history + HTML for `body_clean`. Used on every inbound email parse.

**File:** `src/lib/email-cleaner.ts`

## File header

```
Email body cleaner — strips HTML, quoted replies, signatures, and noise.
Used on inbound email messages before the classifier and AI see them.
Stores both versions:
body (raw) — original untouched, shown in dashboard
body_clean — cleaned output, used by AI/classifier
```

## Exports

### `cleanEmailBody` — function

```ts
function cleanEmailBody(rawBody: string, senderEmail?: string) : string
```

## Callers

- `src/app/api/webhooks/email/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
