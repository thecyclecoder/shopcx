# libraries/remedy-selector

Haiku remedy selection (`selectRemedies()`) + Sonnet open-ended chat (`openEndedCancelChat()`). Uses per-(reason, remedy) stats from [[../tables/remedy_outcomes]].

**File:** `src/lib/remedy-selector.ts`

## File header

```
AI remedy selection — Claude Haiku picks top 3 remedies for cancel retention.
Open-ended reasons get a Sonnet-powered empathetic conversation instead.
```

## Exports

### `isConcreteReason` — function

```ts
function isConcreteReason(_reason: string) : boolean
```

### `selectRemedies` — function

```ts
async function selectRemedies(workspaceId: string, cancelReason: string, customer: CustomerContext, shopifyProductIds: string[], suggestedRemedyId?: string | null,) : Promise<
```

### `generateOpenEndedResponse` — function

```ts
async function generateOpenEndedResponse(workspaceId: string, cancelReason: string, customerMessage: string, conversationHistory: { role: "user" | "assistant"; content: string }[], customer: CustomerContext, products: string[],) : Promise<string>
```

## Callers

- `src/app/api/journey/[token]/chat/route.ts`
- `src/app/api/journey/[token]/remedies/route.ts`

## Gotchas

- Per-(reason, remedy) stats kick in at 200+ data points; otherwise global stats.
- Open-ended chat is capped at 3 turns — never more.
- First-renewal customers get aggressive save offers (25-40% discounts).

## Outage resilience (agent-outage-resilience Phase 3)

Both calls are **synchronous customer-facing** (the cancel-flow remedies step + chat) — the customer is waiting, so there's no Inngest queue to park-and-drain. The Phase 3 no-swallow hardening:

- `selectRemedies` used to fall straight through to the **first-3 remedies on the very first 529** (a silent transient swallow → a degraded save offer). Now it: (1) short-circuits on the breaker (`isClaudeBreakerTripped`) → degrade immediately if Claude is known-down; (2) wraps the Haiku fetch in [[anthropic-retry]] `withAnthropicRetry` (classified throws + `recordClaudeFailure` feed the breaker's local signal) → retries a transient blip in-line; (3) only the catch degrades to the priority-ordered remedies — **explicitly**, logged with the retryable-vs-terminal case. The first-3 fallback is a valid (un-personalised) save offer, so the cancel flow never breaks.
- `generateOpenEndedResponse` (cancel chat) keeps its Sonnet→Haiku fallback + canned escalation reply, now breaker-aware: short-circuits when down and feeds `recordClaudeFailure` on retryable Sonnet/Haiku failures.
  - **Log levels are tuned to the failure stage (signature `vercel:43e4b03698fb1c38`):** the Sonnet-leg failure is an **intermediate** diagnostic logged at `console.warn` — the Haiku fallback below it absorbs a transient overload (529) and typically returns a valid reply, so a top-level `console.error` there would make the [[../integrations/vercel-log-drain]] (`isError()` captures `level==='error'`) mint a **false** Control Tower incident on healthy self-healing. Only the **terminal** both-legs-down case (Haiku also fails → customer gets the canned escalation reply) stays `console.error` and pages. The breaker still records every retryable failure regardless of log level, so the real signal is never lost.
- [[cancel-lead-in]] (`generateCancelLeadIn`) is the **legitimate explicit-optional-degrade** — a cosmetic one-liner whose `null` fallback is intended; left as-is.

## Related

[[anthropic-retry]] · [[claude-health]] · [[../specs/agent-outage-resilience]]

---

[[../README]] · [[../../CLAUDE]]
