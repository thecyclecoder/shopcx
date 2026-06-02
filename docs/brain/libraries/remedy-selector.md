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

---

[[../README]] · [[../../CLAUDE]]
