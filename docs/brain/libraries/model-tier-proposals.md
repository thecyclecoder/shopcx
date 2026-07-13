# libraries/model-tier-proposals

Governed model-tier change proposals ([[../specs/box-agent-model-tiers]] Phase 3) — the ONLY path that changes an agent's [[../tables/agent_model_tiers|model tier]]. A director (or the CEO via Ada's coaching chat) proposes a change citing the agent's [[../tables/agent_action_grades|grade rollup]]; it routes to the agent's supervisor; on approval the registry updates instantly.

**File:** `src/lib/model-tier-proposals.ts`

## Why

A model tier is a low-risk, reversible, in-leash config change — but it still answers to a supervisor (north star: no silent proxy-optimizer). This module is the governance seam: it computes the target's supervisor, applies the spec's auto-apply rail, and otherwise surfaces a `needs_approval` proposal that the **existing** approval inbox decides and the box worker applies. It reinvents nothing — the proposal is an ordinary gated action.

## The flow

1. **Propose** — `proposeModelTierChange` resolves the target's supervisor via [[approval-router]] `resolveApproverLive(ownerFunctionForKind(targetKind))` (a worker's owning function → its director; a director kind is unmapped ⇒ the CEO).
2. **Auto-apply rail** — if that supervisor is a **live+autonomous** director AND the change is within the spec's rail (`isWithinAutoApplyRail`: a one-tier step between two set tiers, triggered by a rollup <7), it applies immediately via [[agent-model-tiers]] `applyModelTierChange` and logs `decided_by='director', autonomous=true` in [[../tables/approval_decisions]].
3. **Escalate** — otherwise it inserts a `proposed-model-tier` [[../tables/agent_jobs]] row (status `needs_approval`) carrying ONE plain `apply_model_tier` action (with `target_kind` + a `ModelTierProposalPayload`). The reconciler ([[approval-inbox]]) surfaces it routed to the supervisor; the inbox one-tap Approve flips it; `approveRoadmapAction` logs the decision; the box worker (`runProposedModelTierJob`) applies it.

## Exports

- **`proposeModelTierChange(admin, workspaceId, { targetKind, proposedTier, proposerFunction, rollup?, evidence? })`** — the entry point. Returns `{applied:true}` (auto-rail), `{applied:false, jobId, routedTo}` (escalated), or `{ok:false, error}` (no-op / invalid).
- **`applyApprovedModelTierProposal(admin, workspaceId, action)`** — apply an approved action's payload (the worker's effect on resume).
- **`isWithinAutoApplyRail(currentTier, proposedTier, rollup)`** — the pure rail predicate.
- **`ModelTierProposalPayload`** — the payload carried on the action.

## Routing (target-aware)

The proposal job's kind is always `proposed-model-tier`, but it must route by the **target** agent, not the proposal kind. [[approval-inbox]] `routingOwnerForJob` reads the action's `target_kind` for this kind so a worker's change routes to its director and a director's own change to the CEO; `approveRoadmapAction` uses the same helper so the ledger's routed_to matches.

## Callers

- **`scripts/builder-worker.ts`** — Ada's coaching chat (`runDirectorCoachJob`) parses a `model_tier` card and calls `proposeModelTierChange` on the CEO's approval; `runProposedModelTierJob` applies an approved `apply_model_tier` action.
- The agent profile ([[../dashboard/agents]] `[role]`) reads the resulting tier + history; the supervisor approves the proposal in the routed inbox.

## Gotchas

- **The CEO seat never auto-applies** — a change that routes to the CEO is always an explicit human decision (the CEO has no supervisor above it to be the proxy of).
- **A change from/to the Max default (null) is never in-rail** — the unset default is outside the haiku<sonnet<opus order, so it always needs explicit approval.
- The apply effect is idempotent (an upsert) — a double-approve can't corrupt the row.

## Related

[[../tables/agent_model_tiers]] · [[agent-model-tiers]] · [[approval-router]] · [[control-tower-node-registry]] · [[approval-inbox]] · [[approval-decisions]] · [[../tables/approval_decisions]] · [[../specs/box-agent-model-tiers]] · [[goal-proposals]] (the sibling director-proposes pattern)
