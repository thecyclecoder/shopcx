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

- **20s upstream deadline.** Both `loggedAppstleFetch` and `loggedActionFetch` bound each outbound call with `AbortSignal.timeout(20_000)` and translate an `AbortError` / `TimeoutError` into `throw new Error("upstream_timeout")`. Callers hit `handleAppstleError` (see [[../libraries/portal-helpers]]) which renders a 502-class response, instead of the portal Lambda hanging until Vercel's 30s runtime-timeout reap. Mirrors [[../libraries/portal-helpers]] `portalFetch`. When translated to `upstream_timeout`, no `appstle_api_calls` row is written for the stall — surface the timeout via the caller's error surface (Control Tower signature `vercel:db57eb2d13e0a610` is the original repro).

---

[[../README]] · [[../../CLAUDE]]
