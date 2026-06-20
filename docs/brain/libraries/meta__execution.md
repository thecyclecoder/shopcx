# libraries/meta/execution

Autonomous execution adapters — Storefront Iteration Engine **Phase 6a**. The
EXECUTOR half of the engine: it takes the `status='decided'` rows the decision
engine wrote to [[../tables/iteration_actions]] (Phase 4a decided → Phase 5 cron
persisted) and applies them to Meta, managing **existing live objects only**.

**File:** `src/lib/meta/execution.ts`

## What it does

For each decided action on `(account, snapshot_date)`:

| `action_type` | adapter | Graph write |
|---|---|---|
| `pause` | flip status → PAUSED | `updateObjectStatus` ([[meta-ads]]) |
| `unpause` | flip status → ACTIVE | `updateObjectStatus` |
| `scale_up` / `scale_down` | set `after_budget_cents` on the object's existing budget field (daily vs lifetime) | `updateObjectBudget` |
| `replenish_creative` | **not enabled yet** — left `status='decided'` | — |

A successful apply flips the [[../tables/iteration_actions]] row to `executed`
(with `external_result` + `executed_at`); a failure → `failed` (with the error in
`external_result`). It NEVER sets ACTIVE on a draft/new object and NEVER creates a
new live spend line — those are draft-only (Phase 6b, [[meta__recommendation-execute]]).

## Governance / safety

- **Bounded by the active policy + ledger that produced the rows.** The decision
  engine already enforced policy, cooldown, the per-account budget-delta ceiling,
  and the noise floors, and persisted guardrail hits as `status='escalated'` —
  this layer only executes rows that are already `decided`, and **never touches
  `escalated` rows**.
- **Idempotent.** Only `status='decided'` rows are executed; the update is guarded
  `.eq("status","decided")`, so a cron re-run never double-applies (the row is no
  longer `decided`). A scale never re-fires on the same snapshot.
- **Ship one action type at a time.** `ENABLED_ADAPTERS` is the explicit allow-list
  (`pause`, `unpause`, `scale_up`, `scale_down`). Enabling `replenish_creative`
  (and its proven-vs-new-creative rule) is a one-line, reviewable change.
- **No-op when inert.** No Meta token, or no decided rows (e.g. no active policy ⇒
  the engine produced none) → returns zeroes and changes nothing.
- **Self-correcting.** A scaled-up object that later drops below the ROAS floor gets
  a `scale_down` decided (graduated failure in [[meta__decision-engine]]); executing
  it here reverts the spend in production.

## Exports

### `executeAutonomousActions` — function

```ts
async function executeAutonomousActions(p: ExecutionParams, snapshotDate: string): Promise<ExecutionResult>
```
`ExecutionParams = { workspaceId, adAccountId (our uuid) }`. Reads decided rows,
resolves each object's budget field (daily/lifetime) from [[../tables/meta_adsets]]
/ [[../tables/meta_campaigns]], applies via the Graph, writes results back. Returns
`{ executed, failed, skipped, byType }`.

### `ENABLED_ADAPTERS` — `ReadonlySet<AutonomousActionType>`

The shipped-and-enabled action types (the rollout allow-list).

## Callers

- [[meta-performance]] `meta-iteration-run` — **stage 7 (`execute`)** of the daily run,
  after `persistActions` lands the decided rows.

## Gotchas

- **CBO/ABO crossover.** A scale with `after_budget_cents = null` (no resolvable
  budget object) is recorded `failed` with that reason rather than guessing.
- A `decided` row is a *planned* action; only after this runs is the change live on
  Meta. Read live state from `status='executed'` + `external_result`, not `decided`.
- Monetary fields are **cents**.

See [[../specs/storefront-iteration-engine]] (Phase 6a) · [[meta__decision-engine]] ·
[[meta__iteration-run]] · [[meta-ads]].
