# libraries/error-text

**One-line renderer for anything a `catch (e)` may hand us — the lossless replacement for
`e instanceof Error ? e.message : String(e)`.**

**File:** `src/lib/error-text.ts`

## Why this exists

A PostgREST error returned by supabase-js is a **plain object**, not an `Error` instance. Verified
on @supabase/postgrest-js 2.100.0: the `{ data, error }` error is built as `JSON.parse(body)` /
`{ message: body }` / a hand-built literal (dist/index.cjs:130-157); `new PostgrestError(...)` is
ONLY constructed when `.throwOnError()` is set. So the ~125 `if (error) throw error` sites across
`src/` throw a plain object, and the legacy `e instanceof Error ? e.message : String(e)` catch
sites render it `[object Object]` — destroying the code + message + details + hint at the exact
moment the diagnostic matters.

The originating incident: Sol's box session `dfa7d984` on ticket `dfa77b28` died 2026-07-21 with
`writeDirection failed: [object Object]` persisted to `agent_jobs.error`, so the real cause was
unrecoverable and the customer (a $2,704-LTV founder-escalated account) was left on "We're looking
into that for you." A supervisor cannot supervise a failure it cannot read.

## Exports

### `errText(e: unknown): string` — function

The single renderer every diagnostic-persisting catch site should call. Never returns
`[object Object]`; never throws on a circular ref; never returns the string `'null'` for `null`.

## Rendering contract, in order

The order is deliberate — the **PostgREST-shaped branch runs BEFORE `instanceof Error`** so a real
`PostgrestError` from a `.throwOnError()` path (which IS an `Error`) does not silently drop its
`code`/`details`/`hint` fields either.

1. `null` / `undefined` → `'unknown error'` (never the string `'null'`).
2. `string` → itself.
3. **PostgREST-shaped object** — any object carrying a non-empty string `message`, whether or not
   it is an `Error`. Rendered as `message` followed by the non-empty subset of `[code] details — hint`,
   e.g. `insert or update on table "ticket_directions" violates foreign key constraint … [23503]
   Key (ticket_id)=(…) is not present in table "tickets".`
4. `Error` (only reached when `message` is empty) → the stack's first line if present, else `e.name`.
5. any other object → `JSON.stringify(e)` guarded by try/catch for circular refs; on failure falls
   back to `Object.prototype.toString.call(e)`. **Never bare `String(e)`** on an object.
6. anything else → `String(e)`.

Result is capped at **2000 chars** so a huge PostgREST body cannot blow the
[[../tables/agent_jobs]] `log_tail` 2000-char budget on its own.

## NEVER return `errText(err)` in a public HTTP response body

`errText` is a **server-side diagnostic renderer**, not a client-facing message. Its whole point
is to **preserve** PostgREST `code` / `details` / `hint`, gateway internals, and constraint text
— exactly the fields you must not disclose to an unauthenticated caller. Every public route that
catches a throw MUST:

1. `console.error(...errText(err)...)` server-side (with route + workspace_id + relevant token in
   the prefix so the log line is greppable), AND
2. return `NextResponse.json({ error: '<generic_code>' }, { status })` with **no** raw error
   content in the body. `<generic_code>` is a stable machine-readable slug (`client_token_failed`,
   `customer_create_failed`, …), never the throw's message.

The `sanitizedCheckoutErrorResponse` helper in `src/app/api/checkout/route.ts` is the same
pattern with a durable ledger — it calls `logCheckoutError` (which itself uses `errText`) instead
of raw `console.error` and passes `{ error: <code> }` to the client.

The originating leak (spec: `checkout-client-token-endpoint-no-raw-errtext-to-client`): the public
cart-token endpoint `src/app/api/checkout/client-token/route.ts` returned `{ error: errText(err) }`
on its 500 branch, exposing PostgREST diagnostics on a payment-path route. Same class was open at
`src/app/api/checkout/identify/route.ts` (`error.message` from a Supabase upsert). Both now use the
log-server-side + generic-code shape above.

## Callers

`Phase 1` ships the renderer + its pinned tests only. Phase 2 of the spec
[[../specs/lossless-error-diagnostics-no-object-object]] converts the ~400 lossy catch sites in
`scripts/builder-worker.ts` and `src/lib/**` to import from here. Phase 3 wires
`scripts/_check-no-lossy-error-stringify.ts` into `predeploy` so a NEW lossy catch cannot land.

## Tests

Pinned at `src/lib/error-text.test.ts` — covers the real 23503 shape captured in the WHY, the
`.single()` `PGRST116` shape, a real `PostgrestError` subclass (throwOnError path), a plain
`Error('boom')`, a bare string, a circular object, `null`, a plain object with no `message`, a
`number`/`boolean` fallback, and the 2000-char cap. Run: `npm run test:error-text`.

## Related

[[../operational-rules]] (supervisable autonomy — a supervisor cannot supervise a failure it
cannot read) · [[../tables/agent_jobs]] (the `error` / `log_tail` columns whose contents this
renderer determines) · [[../integrations/supabase]] (the plain-object PostgREST shape this exists
to render)

---

[[../README]] · [[../../CLAUDE]]
