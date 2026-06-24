# libraries/agent-model-tiers

Per-agent model-tier registry helpers ([[../specs/box-agent-model-tiers]]). Resolves a box agent kind → a [[ai-models]] `MODELS` id (or null = the Max default), and is the single write chokepoint for tier changes. Backs [[../tables/agent_model_tiers]].

**File:** `src/lib/agent-model-tiers.ts`

## Why

Every box `claude -p` agent inherited the one Max-plan default model (no `--model` flag). This module is the seam that lets the box pin a kind to a tier: `modelForKind` is the per-claimed-job lookup the box (`scripts/builder-worker.ts`) calls at dispatch. **Unset kind ⇒ null ⇒ no `--model` ⇒ the Max default (no regression).** The Max nuance: $0/token, so the value of a smaller tier is **speed + less 5-hour-window pressure**, not dollars — reserve opus for quality-critical kinds.

## Exports

- **`modelForKind(admin, workspaceId, kind): Promise<string | null>`** — resolve a kind's pinned model id, or null (unset = Max default). Best-effort: any read error (table absent pre-migration, transient) ⇒ null, so the box never fails to launch a job over a registry hiccup.
- **`applyModelTierChange(admin, { workspaceId, kind, tier, proposedBy, approvedBy }): Promise<{ ok, error? }>`** — the **single write chokepoint**. Upserts the `(workspace_id, agent_kind)` row (`tier=null` clears it back to the Max default), stamping provenance + `updated_at`. Reversible: call again with the prior tier.
- **`listModelTiers(admin, workspaceId): Promise<AgentModelTierRow[]>`** — the full registry for a workspace (the Agents-hub read), newest-updated first.
- **`getModelTier(admin, workspaceId, kind): Promise<AgentModelTierRow | null>`** — one kind's current row (the agent-profile read).
- **`isModelTier(v): v is ModelTier`** — guard for the `haiku｜sonnet｜opus` literal.
- **`AgentModelTierRow`** — the row interface.

## Callers

- **`scripts/builder-worker.ts`** — `runJob` resolves `modelForKind(admin, job.workspace_id, job.kind)` once at dispatch and runs the job inside an `AsyncLocalStorage` context carrying the id; `currentModelArgs()` splices `--model <id>` into EVERY `claude -p` runner (`runClaude`, `runDirectorClaude`, `runRepairClaude`, …) with no call-site threading. Unset ⇒ no flag.
- **`scripts/seed-agent-model-tiers.ts`** — seeds the Phase-2 starting tiers via `applyModelTierChange` (proposed_by/approved_by = `'seed'`).
- The Phase-3 proposal-apply path + the [[../dashboard/agents|Agents hub]] profile reads.

## Gotchas

- **`modelForKind` returns a model *id*, not a tier.** It maps the stored tier through [[ai-models]] `MODELS`, so a deprecated model id changes in ONE place.
- **Never mutate a tier outside `applyModelTierChange`** — it keeps the provenance stamps + `updated_at` consistent and is the governed chokepoint.
- The resolver swallows read errors to null **on purpose** — a registry outage must degrade to the Max default, never block a job.

## Related

[[../tables/agent_model_tiers]] · [[ai-models]] · [[model-tier-proposals]] (the Phase-3 governed change flow) · [[../specs/box-agent-model-tiers]] · [[approval-router]] · [[../tables/approval_decisions]]
