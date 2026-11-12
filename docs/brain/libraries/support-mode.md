# support-mode.ts

`src/lib/support-mode.ts` — the single typed switch that tells every ticket-handling step whether a workspace runs the **CPG** shopper pipeline or the **software** (merchant-support) path.

**Why:** The ShopGrowth support workspace (`f4796217-9dcb-4c7b-b405-6e00f01a2a70`) serves Shopify merchants, not shoppers. The CPG steps (shopper lookup, bucket classifier with refund/order wording, journeys/playbooks, fraud gate, order auto-link, Sol first-touch, Appstle/Shopify actions) are noise at best and wrong at worst for a software tenant. `support_mode` makes them switchable off per workspace with zero change for Superfoods.

Backed by [[../tables/workspaces]] `support_mode` (`text`, default `'cpg'`, check `in ('cpg','software')`).

## Exports

| Export | Signature | Notes |
|---|---|---|
| `SupportMode` | `type = 'cpg' \| 'software'` | The two modes. `'cpg'` is the default for Superfoods + every existing tenant. |
| `getSupportMode` | `(workspaceId: string) => Promise<SupportMode>` | Reads `workspaces.support_mode` via `createAdminClient`. **Any error, null, empty workspaceId, or unknown value reads as `'cpg'`** — a transient failure can never flip Superfoods into the software path. Short in-memory TTL cache (60s) since the mode changes rarely. |
| `isSoftwareMode` | `(m: SupportMode) => boolean` | `m === 'software'`. |
| `shouldRunCpgSteps` | `(m: SupportMode) => boolean` | `m === 'cpg'`. Pure predicate the ticket handler gates every CPG step on (`runCpg`). |
| `isActionAllowedInMode` | `(m: SupportMode, actionType: string) => boolean` | `cpg` → always true. `software` → false for the CPG action types `direct_action` / `journey` / `playbook` / `workflow`; true for everything else (`ai_response` / `kb_response` / `escalate` + the software-mode toolset actions). The action executor's hard guard reads this. |

Tests: `src/lib/support-mode.test.ts`, registered as `npm run test:support-mode` (`tsx --test`). Covers the fail-safe reads (empty id + read-error → `'cpg'`) and both predicates.

## Fail-safe design

`getSupportMode` is deliberately fail-closed toward CPG: the software path only activates on an explicit `support_mode = 'software'` row read. A DB outage, a missing column, or a bad workspace id all degrade to `'cpg'`, so the worst case is "Superfoods behaves exactly as today."

## Callers

- [[../inngest/unified-ticket-handler]] — reads the mode once in a `step.run("support-mode")` (memoized across retries) → `runCpg = shouldRunCpgSteps(mode)`. When `!runCpg` the handler skips classify-bucket (treats the ticket as `'general'`), the active-playbook continuation, the fraud/chargeback gate, both auto-link steps, Sol first-touch, the inflection gate, the Sol playbook short-circuit, Sol direction-apply, and the intent→playbook router, landing straight on `callSonnetOrchestratorV2`. It also now threads `ai_channel_config.instructions` to the orchestrator for **every** workspace as an optional extra system block (empty string = no change).
- [[../libraries/action-executor]] `executeSonnetDecision` — hard guard before the `action_type` switch: `isActionAllowedInMode(mode, action_type)` false → writes `[System] CPG action refused in software mode: <type>`, escalates via `escalateTicket`, and returns `{ escalated: true }` without dispatching.

## Related

- Spec: `software-mode-workspace-switch`
- Migration: `supabase/migrations/20270116120000_workspaces_support_mode.sql`
