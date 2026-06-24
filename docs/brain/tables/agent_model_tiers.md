# agent_model_tiers

The **per-agent model-tier registry** ([[../specs/box-agent-model-tiers]] Phase 1) — the LOCKED config that tiers each box `claude -p` agent by task. One row per `(workspace_id, agent_kind)` maps a kind → a model tier (`haiku｜sonnet｜opus`). The box reads it per claimed job and passes `--model <resolved id>` (resolved through [[../libraries/ai-models]] `MODELS`).

**Why it exists:** every box agent (the org-chart workers Bo/build, Rafa/repair, Fenn/fold … **and** the director Ada) ran with **no `--model` flag** → all inherited the one Max-plan default. Fenn folding brain pages (mechanical) ran on the same model as Bo doing a multi-file build (hardest reasoning). This registry lets a high-volume, mechanical kind drop to a smaller, faster tier; it reserves the big model for the kinds whose quality depends on it.

**The Max nuance** ([[box-multi-account-failover]]): box agents run on the **Max subscription** with `ANTHROPIC_API_KEY` stripped → **$0 marginal per token**. A smaller tier is **not** a dollar saving — its value is **speed** (a Haiku turn finishes faster) and **less 5-hour-usage-window pressure** (the real scarce resource on Max).

**No-regression invariant:** an **unset** kind (no row, or `model_tier` null) ⇒ the box passes **no `--model`** ⇒ the Max default (today's behavior). An unset kind never regresses.

**Workspace-scoped** (mirrors [[agent_jobs]] / [[approval_decisions]] — the tier belongs to the workspace whose agents it governs). RLS: any authenticated user reads (the [[../dashboard/agents|Agents hub]] is owner-gated above the DB); service role does all writes.

**Primary key:** `id` (uuid)

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `agent_kind` | `text` | the agent kind this tier governs — matches [[agent_jobs]]`.kind` (`build｜repair｜fold｜…`). Free text (not an enum) so a new kind can be tiered without a migration |
| `model_tier` | `text?` | `haiku｜sonnet｜opus` (check constraint). **NULL ⇒ unset ⇒ no `--model` ⇒ the Max default** |
| `proposed_by` | `text?` | org-chart function that PROPOSED the current value (the director seat, or `'seed'` for the Phase-2 starting tiers) |
| `approved_by` | `text?` | org-chart function that APPROVED the current value (supervisor seat / `'ceo'` / `'seed'`) |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · bumped on every `applyModelTierChange` |

**Unique:** `(workspace_id, agent_kind)` — the upsert key the resolver + the proposal-apply path use.

## Governance

A tier changes **only** through the director→supervisor proposal flow ([[../specs/box-agent-model-tiers]] Phase 3) — never a silent edit. The proposal cites the agent's [[agent_action_grades|grade rollup]] as evidence, routes to its supervisor via [[../libraries/approval-router]], and on approval is logged in [[approval_decisions]] (auditable, mirrors the leash). Reversible — flip the row back — so it is a low-risk, in-leash config change with **no deploy**. `proposed_by`/`approved_by` record the provenance of the current value.

## Readers / writers

- **`modelForKind(admin, workspaceId, kind)`** ([[../libraries/agent-model-tiers]]) — the box's per-claimed-job lookup → a [[../libraries/ai-models]] model id or null. Called once at dispatch in `scripts/builder-worker.ts` (`runJob`), carried through the job's async tree via `AsyncLocalStorage` so every nested `claude -p` runner splices `--model`.
- **`applyModelTierChange(admin, input)`** ([[../libraries/agent-model-tiers]]) — the single write chokepoint (upsert on the unique key). Called by the seed, the approved proposal, and any CEO coaching edit.
- **`listModelTiers` / `getModelTier`** ([[../libraries/agent-model-tiers]]) — the Agents-hub / agent-profile reads.

## Migration

`supabase/migrations/20260706170000_agent_model_tiers.sql` (apply: `npx tsx scripts/apply-agent-model-tiers-migration.ts`). Idempotent — `create table if not exists` + `create index if not exists` + drop/create policy. Index: `(workspace_id, agent_kind)`. Seed the starting tiers with `npx tsx scripts/seed-agent-model-tiers.ts --apply`.

## Related

[[../specs/box-agent-model-tiers]] · [[../libraries/agent-model-tiers]] · [[../libraries/ai-models]] · [[agent_jobs]] · [[agent_action_grades]] · [[approval_decisions]] · [[box-multi-account-failover]] · [[../operational-rules]] (§ North star — supervisable autonomy)
