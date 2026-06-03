# libraries/ai-models

Model id constants + SDK client. Single source of truth — `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-7`. Never hardcode model ids elsewhere.

**File:** `src/lib/ai-models.ts`

## File header

```
Single source of truth for Anthropic model IDs.
When Anthropic deprecates a model, update the constant here and every
caller picks it up. Do NOT hardcode model strings anywhere else in the
codebase — import from this file instead.
Pricing rows in `ai-usage.ts` reference these constants so the
cost-tracking layer stays in lockstep.
```

## Exports

### `SONNET_MODEL` — const

```ts
const SONNET_MODEL
```

### `HAIKU_MODEL` — const

```ts
const HAIKU_MODEL
```

### `OPUS_MODEL` — const

```ts
const OPUS_MODEL
```

### `MODELS` — const

```ts
const MODELS
```

### `ModelTier` — type

## Callers

- `src/app/api/tickets/[id]/analysis/override/route.ts`
- `src/app/api/tickets/[id]/apply-macro/route.ts`
- `src/app/api/tickets/[id]/improve/route.ts`
- `src/app/api/tickets/[id]/suggest-pattern/route.ts`
- `src/app/api/tickets/[id]/tag-feedback/route.ts`
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/analyze/route.ts`
- `src/app/api/workspaces/[id]/knowledge-base/generate/route.ts`
- `src/app/api/workspaces/[id]/playbooks/fix/route.ts`
- `src/app/api/workspaces/[id]/playbooks/simulate/route.ts`
- `src/app/api/workspaces/[id]/products/[productId]/generate-complementarity/route.ts`
- `src/app/api/workspaces/[id]/products/[productId]/reconcile-benefits/route.ts`
- `src/app/api/workspaces/[id]/products/[productId]/regenerate-field/route.ts`
- `src/lib/cancel-lead-in.ts`
- `src/lib/daily-analysis-report.ts`
- `src/lib/fraud-detector.ts`
- `src/lib/inngest/ai-nightly-analysis.ts`
- `src/lib/inngest/customer-demographics.ts`
- `src/lib/inngest/fraud-detection.ts`
- `src/lib/inngest/product-intelligence.ts`
- … and 11 more

## Gotchas

- Model id constants are the single source of truth. Never hardcode strings elsewhere — bump the constant when models change.
- Don't import the Anthropic SDK directly outside `ai-models.ts` + `ai-usage.ts`.

---

[[../README]] · [[../../CLAUDE]]
