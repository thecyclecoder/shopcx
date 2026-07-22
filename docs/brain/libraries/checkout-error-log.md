# libraries/checkout-error-log

**Checkout error recording — logs errors that stop or hurt a checkout so diagnostics are lossless (full PostgREST-shaped errors preserved server-side, never `[object Object]`), while the client sees only a stable machine-readable error code.**

**File:** `src/lib/checkout-error-log.ts`

## Why this exists

Checkout error diagnostics are **customer-critical**: a declined card, a tax calculation failure, a Braintree configuration error, or a missing order row must be fully visible to support and the founder for real-time triage. Server code that catches errors at the payment stage must log the FULL error (code + details + hints for PostgREST, stack for `Error` instances) and NEVER return raw `err.message` to the client — that would expose gateway config text, Postgres internals, or infra stack shape as information disclosure on the payment path. The [[../libraries/error-text]] `errText` renderer ensures even plain PostgREST objects render with their code/details/hint, and this logger ensures it lands durably in [[../tables/checkout_errors]] for support + founder visibility. See [[storefront-checkout]] Phase 5 on-failure branch.

## Exports

### `CheckoutErrorStage` — type union

```typescript
type CheckoutErrorStage =
  | "client_token"
  | "identify"
  | "otp"
  | "tax"
  | "tokenize"
  | "braintree_charge"
  | "order_insert"
  | "subscription_insert"
  | "validation"
  | "submit"
  | "other";
```

The flow stage where the error happened — used to filter and correlate errors by checkout phase.

### `CheckoutErrorInput` — interface

```typescript
interface CheckoutErrorInput {
  workspaceId: string;
  stage: CheckoutErrorStage;
  side?: "client" | "server";
  cartToken?: string | null;
  customerId?: string | null;
  anonymousId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  context?: Record<string, unknown>;
  userAgent?: string | null;
}
```

Shape passed to `logCheckoutError`. All fields optional except `workspaceId` and `stage`.

### `logCheckoutError(input: CheckoutErrorInput): Promise<void>` — function

Records an error to the [[../tables/checkout_errors]] table. Best-effort + never throws — logging a failure must never itself break the (already-failing) checkout path. Caps `errorMessage` at 2000 chars (inline with [[../libraries/error-text]] cap). Server code calls this directly; the client POSTs to `/api/checkout/log-error` which calls this server-side.

## Callers

- `/api/checkout` route: every error path routes through `sanitizedCheckoutErrorResponse` helper (inline in `src/app/api/checkout/route.ts`), which calls `logCheckoutError` with the FULL error via `errText(error)` before returning a sanitized `{ error: <code> }` to the client (shipped 2026-07-22).
- `/api/checkout/log-error` endpoint (client-side error reporting): posts to the server, which calls `logCheckoutError` with client-supplied context.

## Related

[[../libraries/error-text]] · [[../tables/checkout_errors]] · [[storefront-checkout]] · [[../integrations/braintree]]

---

[[../README]] · [[../../CLAUDE]]
