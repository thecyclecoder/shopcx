# libraries/email-utils

Threading helpers: `In-Reply-To` + `References` header builders.

**File:** `src/lib/email-utils.ts`

## File header

```
Strip email signatures from HTML email bodies for cleaner display.
Preserves the full body in storage — this is display-only.
```

## Exports

### `stripEmailSignature` — function

```ts
function stripEmailSignature(html: string) : string
```

### `stripQuotedReply` — function

```ts
function stripQuotedReply(html: string) : string
```

### `cleanEmailForDisplay` — function

```ts
function cleanEmailForDisplay(html: string) : string
```

## Callers

- `src/app/api/webhooks/email/route.ts`
- `src/app/dashboard/tickets/[id]/page.tsx`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
