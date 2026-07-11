# libraries/anthropic-retry

Classifies a raw-fetch Claude/Anthropic failure as **retryable dependency outage** vs **terminal logic/auth bug**, and throws the right error so Inngest does the right thing. The shared spine of the [[../specs/agent-outage-resilience]] fix: a failed Claude call must THROW (→ retry), never silently swallow into `""` / a default decision.

**File:** `src/lib/anthropic-retry.ts`

## Why

A real Anthropic outage must be a **pause, not a drop**. Before this, the raw-fetch Claude calls on the ticket path swallowed non-2xx into `""` (`unified-ticket-handler.ts:173`), a grade-skip (`ticket-analyzer.ts` `grader_http_*`), or a generic "escalate" decision (`sonnet-orchestrator-v2.ts`) — so a 1-hour outage failed-and-dropped in-flight work. This module makes every such call throw a **classified** error:

- **retryable** (429 / 5xx / 529-overloaded / timeout / network) → `AnthropicDependencyError` (a plain `Error` → Inngest retries with exponential backoff; with `OUTAGE_SPANNING_RETRIES` the curve spans hours).
- **terminal** (4xx other than 429 — bad request, bad key) → `NonRetriableError` (fail fast; never burn hours of retries on a bug).

## Exports

### `OUTAGE_SPANNING_RETRIES` — const (`20`)
Inngest's max retry count. Set as the `retries:` on customer-facing Claude-dependent Inngest fns so the default backoff curve extends out to hours. Used by [[../inngest/unified-ticket-handler]].

### `isRetryableAnthropicStatus(status: number): boolean`
`true` for 408 / 409 / 425 / 429 / ≥500. Used to branch retry-vs-degrade at a call site (e.g. the orchestrator API-error block).

### `class AnthropicDependencyError extends Error` (`.status?`)
Thrown for a retryable dependency failure. Named so callers + the Phase-2 circuit-breaker's local consecutive-failure counter can recognise a dependency outage as distinct from a logic bug.

### `throwForAnthropicStatus(status, where): never`
Non-2xx → retryable status throws `AnthropicDependencyError`, terminal throws `NonRetriableError`.

### `throwForAnthropicNetworkError(err, where): never`
A network-level fetch failure (DNS/reset/hang-up/timeout) → always `AnthropicDependencyError` (transient).

### `isRetryableThrownError(err): boolean`
For generic catch sites: `true` for `AnthropicDependencyError` + raw undici/network fetch failures (`fetch failed` + ECONNRESET/ETIMEDOUT/… causes); `false` for `NonRetriableError`. Lets a catch re-throw / defer the outage cases while still degrading on genuine logic errors.

### `withAnthropicRetry<T>(fn, opts?): Promise<T>` — Phase 3
In-line bounded retry for a Claude call on a **synchronous (non-Inngest) path** — an API route / portal handler where the customer is waiting, so there's no Inngest queue to span an outage. The thunk classifies its own failures (`throwForAnthropicStatus` / `throwForAnthropicNetworkError`); the helper retries a *retryable* throw a few times with short exponential backoff (`attempts` default 3, `baseDelayMs` default 400 → 800 → …), **fails fast** on a `NonRetriableError`, and re-throws the last retryable error once exhausted so the caller degrades **explicitly**. Callers should short-circuit on the breaker (`isClaudeBreakerTripped`) *before* this — don't make the customer sit through retries to a known-dead API.

## Callers

- [[unified-ticket-handler]] — `claude()` helper throws via `throwForAnthropicStatus` / `throwForAnthropicNetworkError`; fn `retries: OUTAGE_SPANNING_RETRIES`.
- [[sonnet-orchestrator-v2]] — API-error block throws `AnthropicDependencyError` on `isRetryableAnthropicStatus`; top-level catch re-throws on `isRetryableThrownError`.
- [[ticket-analyzer]] — grader fetch throws instead of returning `grader_http_*`.
- [[../inngest/ticket-analysis-cron]] — catches `isRetryableThrownError` → **defers** the ticket (leaves `last_analyzed_at` untouched → next */30 tick re-grades on recovery).
- [[remedy-selector]] — **Phase 3**: `selectRemedies` wraps its Haiku fetch in `withAnthropicRetry` + breaker short-circuit; `generateOpenEndedResponse` (cancel chat) feeds the breaker signal + short-circuits. Both degrade **explicitly** (priority-ordered remedies / escalation reply), never a silent swallow of the first 529.
- [[competitors]] — `runDiscovery` throws via `throwForAnthropicStatus` / `throwForAnthropicNetworkError` on Anthropic failures; paired with `retries: OUTAGE_SPANNING_RETRIES` on [[../inngest/competitor-scout]], a transient blip parks-and-drains instead of paging Control Tower.

## Gotchas

- **Genuinely-optional enrichment may still degrade** (return `""`), but the caller must opt in **explicitly** (e.g. `claude(..., { optional: true })` — only `personalizeMacroText` does). It's never the accidental default.
- A `NonRetriableError` propagating out of a `step.run` is honoured by Inngest as fail-fast — the run does NOT retry it.

## Related

[[../integrations/anthropic]] · [[unified-ticket-handler]] · [[sonnet-orchestrator-v2]] · [[ticket-analyzer]] · [[../inngest/ticket-analysis-cron]] · [[competitors]] · [[../inngest/competitor-scout]] · [[../specs/agent-outage-resilience]]
