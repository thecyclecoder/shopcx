# `src/lib/subscriber-experiments.ts` — the subscriber lifecycle-experiment harness SDK

The ONE sanctioned chokepoint for the person-level experiment tables
([[../tables/customer_lifecycle_experiments]] + [[../tables/customer_lifecycle_experiment_assignments]]) — CLAUDE.md raw-`.from` STOP rule, enforced by `scripts/_check-subscriber-experiments-sdk-compliance.ts` (wired into `predeploy:static` as `check:subscriber-experiments-sdk-compliance`). Spec: `subscriber-experiment-harness`. Part of the [[../lifecycles/pre-renewal-reminder-journey]] flow (M3 "Self-running 50/50 test").

This is a NEW harness, deliberately NOT [[storefront-experiments]]: that framework is visitor/render grain with content-patch variants — the wrong grain (visitor, not person) and the wrong lever (content, not send/no-send) for a subscriber messaging test. Here assignment is persisted ONCE at the person level and never re-bucketed.

## Why the person grain

Grain is the PERSON, not the account. One real person can hold several linked accounts under one [[../tables/customer_links]] `group_id`; the SDK resolves that whole group BEFORE bucketing so two accounts of the same person never land in opposite arms. The assignment key is the `group_id` (or the customer's own id for an unlinked customer — its singleton group), never a bare `customer_id`.

## Exports

| Export | Signature | What |
|---|---|---|
| `SUBSCRIBER_EXPERIMENT_NODE_ID` | `const "tool:subscriber-experiment-harness"` | the canonical node id in [[control-tower-node-registry]] (owner: retention) passed to `resolveEffectiveSwitch`. |
| `linkedIds(admin, customerId)` | `Promise<string[]>` | the full linked-account group ([[../tables/customer_links]]); falls back to `[customerId]` when unlinked. |
| `resolveGroupId(admin, customerId)` | `Promise<string>` | the stable identity GROUP id (the `customer_links.group_id`, or `customerId` for a singleton). THE assignment key. |
| `hashToUnit(key)` | `number` | sha256 → unit float `[0,1)`, deterministic across processes (sticky without persisting). |
| `bucketArm(experimentId, groupId, holdoutPct)` | `ExperimentArm` | bands `hashToUnit(group:experiment)` → `holdout` (`[0, holdout_pct/100)`) else `treatment`. |
| `powerCalcRequiredN({ mde, power, alpha, baselineCv })` | `number` | required N per arm = `2 (z_{1-α/2} + z_{1-β})² CV² / MDE²` — the PRE-REGISTERED sample size. |
| `createExperiment(workspaceId, input, admin?)` | `Promise<row>` | idempotent on `(workspace_id, slug)`; stamps the power-calc `required_n_per_arm` + `stop_rule` at creation — nothing launches without them. |
| `getExperiment(workspaceId, slug, admin?)` | `Promise<row \| null>` | resolve an experiment by slug. |
| `getArm(workspaceId, slug, customerId, admin?)` | `Promise<ExperimentArm \| null>` | read a group's STORED arm without ever minting a new one. |
| `assignArm(workspaceId, slug, customerId, admin?)` | `Promise<ExperimentArm \| null>` | assign (or read) the permanent arm — the core call. |
| `listAssignments(workspaceId, slug, admin?)` | `Promise<ExperimentAssignmentRow[]>` | EVERY sticky assignment (group_id · arm · assigned_at) — the sanctioned READ chokepoint the measurement engines ([[subscriber-experiment-metrics]]) bucket by; `[]` when the experiment doesn't exist. |

## `assignArm` — sticky per-customer 50/50 + true holdout

1. Resolve the customer's full linked-account GROUP (`resolveGroupId`) — all of a person's accounts share one arm.
2. If an assignment already exists for the group, return the STORED arm (sticky — fixed at first eligibility, never re-bucketed).
3. Otherwise honour the kill switch: if the harness node is OFF (`resolveEffectiveSwitch(SUBSCRIBER_EXPERIMENT_NODE_ID)`), DO NOT mint a new assignment (returns `null`) — a trip stops NEW assignments without destroying existing ones.
4. Band the group's sticky hash into `treatment`/`holdout` at the configured split and persist once under the UNIQUE `(experiment_id, group_id)` constraint. A concurrent first-touch race converges on the single winning insert (the loser re-reads the winner).

Callers (the M2 reminder sends) ask `assignArm` / `getArm` whether a customer is treatment or holdout; the holdout gets nothing new, so the 90-day net-revenue verdict is computed on a clean, fixed assignment.

## Pre-registration (power calc + stop rule)

`createExperiment` requires a `powerCalc` ({ mde, power, alpha, baselineCv }) + a `stopRule`, and stamps `required_n_per_arm` (= `powerCalcRequiredN(...)`) + `stop_rule` on the row BEFORE launch. The downstream verdict reads that fixed N rather than deciding N after seeing data — that is what makes the self-running test's verdict credible. `powerCalcRequiredN` uses an inline inverse-normal (Acklam) so there is no stats dependency.

## Supervisable autonomy (north star)

The harness is a first-class node under the `retention` function in [[control-tower-node-registry]] (`STATIC_TOOL_NODES` → `tool:subscriber-experiment-harness`) with a [[../tables/kill_switches]] ancestry. `assignArm` honours the switch (step 3 above). The downstream guardrails/verdict spec owns the runtime cron + heartbeat; this harness only establishes the pre-registration + the owner/switch.

## Status is the real on/off switch (launch-readiness Phase 4)

Reminders go out ONLY while the experiment `status` is `running`:

- `isExperimentRunning(experiment)` — pure predicate (`status === 'running'`).
- `assignArm` returns **null unless running** — the gate sits BEFORE the stored-arm read, so `stopped`/`complete` halts ALL further reminders (new AND existing assignees); the sticky assignment row is preserved for measurement. `draft` sends nothing.
- `setExperimentStatus(workspaceId, slug, status, { by, reason })` — the ONLY sanctioned writer of `status`, recording who/why (`status_changed_by/_reason/_at`). `createExperiment` still defaults to `draft`; launch is a deliberate flip to `running`. North star: no silent proxy flip.
- `recordExperimentVerdict(...)` — flips to `complete` + persists the terminal verdict (`verdict`/`verdict_detail`/`verdict_at`) in one write; called by [[../inngest/subscriber-experiment-guardrails]].

## Related
[[../tables/customer_lifecycle_experiments]] · [[../tables/customer_lifecycle_experiment_assignments]] · [[../tables/customer_links]] · [[../tables/kill_switches]] · [[control-tower-node-registry]] · [[kill-switch-resolver]] · [[subscriber-experiment-guardrails]] · [[storefront-experiments]] (the visitor-grain sibling this is deliberately NOT)
