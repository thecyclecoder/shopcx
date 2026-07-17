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

### `canonicalizeEmail` — function

```ts
function canonicalizeEmail(email: string) : string
```

Pure identity canonicalizer — two strings that resolve to the same real
inbox compare equal. Always trim + lowercase. For `gmail.com` /
`googlemail.com` **only**: remove all `.` from the local part, drop
everything from the first `+` in the local part, and normalize the domain
to `gmail.com`. For every other provider, dots are significant so the
address is returned trimmed+lowercased unchanged (stripping non-gmail dots
would fuse distinct inboxes).

**Wedge:** ticket 54f0f29e — support email `metz.julie323@gmail.com` spawned
an empty shadow of the real record `metzjulie323@gmail.com` because inbound
ingest looked up by exact string. This helper is the shared canonicalizer
that ingest ([[../../../src/app/api/webhooks/email/route.ts]]) and
[[account-matching]] agree on. Backed by an indexed
[[../tables/customers]]`.email_canonical` column.

## Callers

- `src/app/api/webhooks/email/route.ts`
- `src/app/dashboard/tickets/[id]/page.tsx`
- `src/lib/account-matching.ts` (`canonicalizeEmail` — email branch of `findUnlinkedMatches`)

## Gotchas

- **Never strip dots outside Gmail.** Other providers treat dots as
  significant, so `first.last@fastmail.com` and `firstlast@fastmail.com`
  are distinct inboxes. Only `gmail.com` / `googlemail.com` collapse.
- **`+tag` is only stripped for Gmail.** Some providers use `+` for
  routing but tag semantics vary; only Gmail's rule is safe to bake in.
- **Malformed input never throws.** Empty / no-`@` / trailing-`@` inputs
  return the trimmed+lowered original so the caller can still compare it
  as a plain string (matches what today's exact-string lookup sees).

---

[[../README]] · [[../../CLAUDE]]
