# Per-agent model tiers + director-proposed model changes

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/devops-director]] (the org learns + self-manages) · extends [[worker-grading-and-director-management]] (the grades become the evidence for a model change).

**Found in use 2026-06-23** (CEO review of the agent fleet): every box `claude -p` agent — the org-chart workers (Bo/build, Rafa/repair, Fenn/fold …) **and** the director (Ada) — runs with **no `--model` flag**, so they all inherit the **one Max-plan default model**. They are not tiered by task: Fenn folding brain pages (mechanical) runs on the same model as Bo doing a multi-file build (the hardest reasoning). Two problems: (1) no way to put a routine, high-volume worker on a cheaper/faster model; (2) no governed way to *change* an agent's model as we learn (e.g. its grades slip on a small model).

**The Max nuance (state it up front so we tune the right thing):** box agents run on the **Max subscription** with `ANTHROPIC_API_KEY` stripped → **$0 marginal per token**. So a smaller model is **not** a direct dollar saving — its value is **speed** (a Haiku turn finishes faster) and **less 5-hour-usage-window pressure** (the real scarce resource on Max; [[box-multi-account-failover]]). Reserve the big model for the agents whose *quality* depends on it; put mechanical, high-volume agents on a smaller, faster one so they don't burn the window or jam the lanes.

## The cascade tie-in (why this lives with grading)
The [[worker-grading-and-director-management|worker grades]] are the **evidence** for a model change. The loop: a worker's [[../tables/agent_action_grades|rollup]] slips on a small model → the director (its supervisor) proposes a bump → the CEO approves → the registry updates → the worker re-runs on the new model → re-graded. The org tunes its own models from its own grades — exactly the devops-director goal "the org learns + self-manages."

## Job-rating tie / the model registry (the locked config — tune via the proposal flow)
- **Registry:** a workspace-scoped table `agent_model_tiers` (`agent_kind` → `model_tier ∈ haiku｜sonnet｜opus`, nullable = the Max default, so an unset kind never regresses). The box reads it per claimed job and passes `--model <resolved id>` (resolved through [[../libraries/ai-models]] `MODELS`); unset → no flag → the Max default (today's behavior).
- **Gradeable unit / governance:** a model tier changes ONLY through the proposal flow (P3) — never a silent edit. Reversible (flip the row back), so it's a low-risk, in-leash config change.

### Per-agent recommendations (starting tiers — calibratable via the proposal flow + the grades)
| Agent (`kind`) | Persona | Tier | Why |
|---|---|---|---|
| `build` | Bo | **opus** | multi-file spec builds — the hardest reasoning; quality dominates |
| `repair` | Rafa | **opus** | real root-cause (not symptom) diagnosis |
| `regression` | Remi | **opus** | judging real vs flaky + authoring a sound fix |
| `migration-fix` | Mira | **opus** | billing-integrity judgment — a wrong call risks a renewal |
| `spec-test` | Vera | **opus** | adversarial verification — must catch a false-✅ |
| `plan` | Pia | **opus** | goal decomposition + correct `blocked_by` |
| `spec-chat` | Sage | **opus** | spec authoring with the founder |
| `dev-ask` | Dex | **opus** | open-ended read-only investigation |
| `platform-director` · `director-coach` | Ada | **opus** | supervises, makes leash calls, coaches — judgment-heavy |
| `triage-escalations` | (solver/skeptic) | **opus** | solver→skeptic→quorum reasoning |
| `product-seed` | Sol | **sonnet** | structured pipeline + web research — bounded |
| `storefront-optimizer` | — | **sonnet** | one hypothesis from a lever map |
| `ticket-improve` | — | **sonnet** | bounded CX investigation |
| `db_health` | Devi | **sonnet** | EXPLAIN analysis — fairly mechanical |
| `pr-resolve` | Pax | **sonnet** | mechanical merge, but must not break the `tsc` gate |
| `fold` | Fenn | **haiku** | folding into brain pages — mechanical, high-volume |
| `coverage-register` | Cole | **haiku** | registry entry / exemption — simple |
| `monitor` | Tao | **haiku** | alert accuracy — simple, frequent |

These are *recommendations*, not gospel — every one is calibratable through the proposal flow, and a slipping grade is the trigger to revisit.

## Phases
- **P1 — registry + box wiring ✅** — migration `agent_model_tiers` (`workspace_id`, `agent_kind`, `model_tier`, `proposed_by`, `approved_by`, timestamps; unique on `(workspace_id, agent_kind)`) — `supabase/migrations/20260706170000_agent_model_tiers.sql` + `scripts/apply-agent-model-tiers-migration.ts`. Helper `modelForKind(admin, workspaceId, kind)` → a [[../libraries/ai-models]] model id or null — `src/lib/agent-model-tiers.ts`. Wired `scripts/builder-worker.ts`: `runJob` resolves the claimed job's kind tier ONCE at dispatch and carries it through the job's async tree via `AsyncLocalStorage` (`_modelCtx`); `currentModelArgs()` splices `--model <id>` into EVERY `claude -p` runner (no call-site threading). Unset kind / any read error ⇒ no flag ⇒ the Max default (no regression). Brain: `tables/agent_model_tiers` · `libraries/agent-model-tiers`. **⚠️ Still to verify before relying on it:** the Max CLI honors `--model` for each of haiku/sonnet/opus (availability on the Max plan) — wiring passes the resolved full model id from `MODELS`.
- **P2 — seed the recommendations ✅** — `scripts/seed-agent-model-tiers.ts` (dry-run by default, `--apply` to write) upserts the table above as the starting tiers via `applyModelTierChange` (proposed_by/approved_by = `'seed'`) for every workspace. Unset kinds stay on the Max default. **Run `npx tsx scripts/seed-agent-model-tiers.ts --apply` after the migration is applied.**
- **P3 — director-proposed model change (governed) ✅** — `src/lib/model-tier-proposals.ts` (`proposeModelTierChange`). A director (or the CEO via Ada's coaching chat) PROPOSES a change citing the [[../tables/agent_action_grades|grade rollup]]; it routes to the target agent's supervisor via [[../libraries/approval-router]] `resolveApproverLive(ownerFunctionForKind(targetKind))` (worker→director, director→CEO). A **live+autonomous** supervising director auto-applies a change **within the rail** (`isWithinAutoApplyRail`: a one-tier step between two set tiers, rollup <7) — logged `decided_by='director', autonomous=true` in `approval_decisions`; otherwise it ESCALATES as a `proposed-model-tier` [[../tables/agent_jobs]] row (`needs_approval`, one plain `apply_model_tier` action) the existing reconciler surfaces, the inbox one-taps, `approveRoadmapAction` logs, and `runProposedModelTierJob` applies (instant, reversible). Target-aware routing added to `approval-inbox.ts` (`routingOwnerForJob`) so the proposal routes by the TARGET kind, not the proposal kind. Brain: `libraries/model-tier-proposals`.
- **P4 — surface on the agent profile ✅** — `src/components/agents/model-tier-card.tsx` + `GET /api/developer/agents/model-tier` show **Model: {tier}** + the change history on each worker/director profile (`/dashboard/agents/[role]`); the supervisor's one-tap Approve is the existing routed inbox (the proposal surfaces there, deep-linking back to the profile). Ada's coaching chat authors a proposal directly via a new `model_tier` card ("Fenn's fold quality dropped — propose Sonnet") → `proposeModelTierChange` on the CEO's approval.

## Build status (2026-06-24)
**All four phases shipped** — P1 (registry + resolver + box `--model` wiring), P2 (seed), P3 (governed proposal engine: propose → target-aware route → auto-rail/escalate → `approval_decisions`-logged → apply), P4 (profile Model + history + reused one-tap approve + coaching-chat authoring). `npx tsc --noEmit` clean.

**Open verification (owner / non-destructive):** confirm the **Max CLI honors `--model`** for each of haiku/sonnet/opus before relying on the tiering (P1 passes the resolved full `MODELS` id). The coach-chat `model_tier` card renders generically (by summary + Approve/Decline) — a type-specific card chrome is optional polish, not blocking.

**Apply steps (no prod creds on the box — owner runs):** `npx tsx scripts/apply-agent-model-tiers-migration.ts` then `npx tsx scripts/seed-agent-model-tiers.ts --apply`.

## Verification
- An `agent_model_tiers` row for `kind='fold'='haiku'` makes the box pass `--model` (the haiku id) on the next fold job; an unset kind passes no `--model` (the Max default — no regression).
- A director proposing a model change for a worker creates an `approval_decisions`-logged proposal routed to the supervisor; on approval the registry row updates and the next job of that kind uses the new model.
- A worker whose rollup is <7 on a small model → the director proposes a bump (auto within the rail, else escalated); flipping the row back reverts cleanly.
- The agent profile shows the current model + lets the supervisor approve a pending change.
