# libraries/optimizer-policy

The storefront optimizer's **activation + product-scope gate** — the read-only policy loader the optimizer (M4) + bandit framework (M1) consult before any autonomous **live** action. The storefront equivalent of the ad engine's [[meta__decision-engine]] `loadActivePolicy` ("no active policy → zero autonomous actions"). Reads [[../tables/storefront_optimizer_policy]]; the engine never writes it.

**File:** `src/lib/storefront/optimizer-policy.ts` · Reads [[../tables/storefront_optimizer_policy]] · Consumed by [[storefront-experiments]] (render gate) + [[storefront-experiment-refresh]] (promote gate) + the M4 agent (enqueue/activation gate, when it ships). See spec `docs/brain/specs/storefront-optimizer-activation-gate.md`.

## Exports

### `loadStorefrontOptimizerPolicy(admin, workspaceId)` → `StorefrontOptimizerPolicy | null`
The workspace's policy row, typed, or `null` when none exists. Best-effort: returns `null` if the table isn't present yet (pre-migration) so callers degrade gracefully. `null` ⇒ propose-only (the OFF-by-default invariant) via `optimizerGateOpen`.

### `optimizerGateOpen(policy, productId)` → `boolean`
The single gate every campaign-enqueue / experiment-activation / live-variant-serve checks: `policy exists && policy.active && productId ∈ product_scope`. Anything else ⇒ propose-only (no live action on that product).

### `isProductInScope(policy, productId)` → `boolean`
Whether a product is in the enforced `product_scope` allowlist (false for an empty/absent scope). Scope is checked independently of `active` so callers can distinguish "OFF" from "out of scope".

### `StorefrontOptimizerPolicy` (interface) · `DEFAULT_OPTIMIZER_GUARDRAILS`
The typed policy contract + the default guardrails a fresh OFF policy carries (and the fallback shape the dashboard renders before a row exists). Guardrail defaults mirror the M1 constants in [[storefront-experiment-refresh]].

## Why

Supervisable autonomy ([[../operational-rules]] § North star): the optimizer optimizes a bounded proxy within a policy its supervisor (the Growth director) owns. With the gate off there is **no path** by which the optimizer mutates live storefront content or assigns a live variant — it stays a watchable dry-run until the owner's explicit "go".
