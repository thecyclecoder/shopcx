# libraries/appstle-call-log

`loggedAppstleFetch()` — wraps every Appstle HTTP call into [[../tables/appstle_api_calls]] for replay + debugging.

**File:** `src/lib/appstle-call-log.ts`

## File header

```
AsyncLocalStorage-based context + logger for Appstle (and other
subscription-platform) API calls triggered by direct actions.
Every Appstle fetch wraps with logAppstleCall() to record:
• action_type (swap_variant, apply_coupon, etc.)
• request URL, body, method
• response status, body
• success/failure + error summary
• back-link to the ticket that triggered it
The action executor wraps each direct-action handler in
withActionContext() so the helpers fetch the ticket/workspace ids
implicitly — no need to thread them through every helper signature.
```

## Exports

### `getActionContext` — function

```ts
function getActionContext() : ActionLogContext | undefined
```

### `logAppstleCall` — function

```ts
async function logAppstleCall(params: CallLogParams) : Promise<void>
```

### `loggedAppstleFetch` — function

```ts
async function loggedAppstleFetch(url: string, init?: RequestInit, endpoint?: string,) : Promise<Response>
```

### `loggedActionFetch` — function

```ts
async function loggedActionFetch(url: string, init: RequestInit, opts: { endpoint: string; bodySuccessCheck?: (body: string) => boolean },) : Promise<Response>
```

## Callers

- `src/lib/appstle.ts`
- `src/lib/replacement-order.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
