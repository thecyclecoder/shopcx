# libraries/storefront-optimizer-policy

Phase 1 of the Storefront Optimizer activation gate: the **read-only policy gate**
the optimizer agent (M4) consults before it proposes any campaign. The storefront
analogue of [[meta__decision-engine]] `loadActivePolicy` over [[../tables/iteration_policies]]:
the engine reads the policy, never writes it. **No policy / `active=false` ⇒ zero
proposals** (safe-by-default). See [[../specs/storefront-optimizer-activation-gate]].

**File:** `src/lib/storefront/optimizer-policy.ts` · Reads [[../tables/storefront_optimizer_policy]] · Consumed by M4 ([[../specs/storefront-optimizer-agent]]) + the `/dashboard/storefront/optimizer` control surface.

## Exports

### `loadOptimizerPolicy(admin, workspaceId)` → `Promise<OptimizerPolicy | null>`
Loads the workspace's single policy row (`maybeSingle`). Returns `null` when there's
no row — the agent then treats the optimizer as OFF. Best-effort: returns `null` if
the table doesn't exist yet (pre-migration), degrading gracefully like
[[storefront-experiments]] `loadActiveExperiments`.

### `evaluateProposalGate(policy, { productId, leverClass })` → `ProposalGate`
The single gate M4 calls before proposing a campaign. Encodes the full
propose-and-approve contract:

| policy / input | `disposition` | `canPropose` |
|---|---|---|
| null or `active=false` | `idle` | false |
| active, product ∉ `product_scope` | `refused_scope` | false |
| active, in scope, `offer`/`structural` lever | `needs_approval` | true |
| active, in scope, `reversible` lever, `auto_run_reversible=false` | `needs_approval` | true |
| active, in scope, `reversible` lever, `auto_run_reversible=true` | `auto_run` | true |

There is **no path to live traffic** without either the owner's Build/Approve tap
(`needs_approval`) or the explicit reversible-lever auto-run opt-in. Returns a
legible `reason` for the agent's surfaced reasoning + the card.

### `isOptimizerActive(policy)`, `isProductInScope(policy, productId)`
Boolean helpers the gate composes from (also usable directly).

### Types
`OptimizerPolicy` (typed row), `LeverClass` (`reversible｜offer｜structural`),
`GateDisposition` (`idle｜refused_scope｜needs_approval｜auto_run`), `ProposalGate`.

## Gotchas
- **Read-only.** This file never writes the policy — humans/Growth edit it via the
  dashboard API. The engine reading its own writes would defeat supervisable autonomy.
- **`auto_run` only ever applies to `reversible` levers** — offers + structural
  rewrites are always `needs_approval`, regardless of `auto_run_reversible`.
- **Scope is enforced, not narrative** — an out-of-scope product returns
  `refused_scope` (`canPropose=false`), not merely "unscheduled."
- M1 ([[storefront-experiments]] `loadActiveExperiments`) independently only serves a
  live variant for a `running`/`promoted` experiment — an unapproved (draft)
  proposal never assigns live traffic, which complements this gate.
