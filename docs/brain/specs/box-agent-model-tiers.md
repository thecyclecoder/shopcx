# Per-agent model tiers + director-proposed model changes ⏳

**Priority:** critical

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
- **P3 — director-proposed model change (governed) ⏳** — a director may PROPOSE a model change for one of its agents, citing the agent's [[../tables/agent_action_grades|grade rollup]] as evidence, and **ship it to its supervisor for approval** (reuse [[../libraries/approval-router]] — a worker's model change routes to its director; the director's own model change routes to the CEO). On approval, the `agent_model_tiers` row updates instantly (reversible, no deploy). The proposal is an `approval_decisions`-logged action (auditable, mirrors the leash). A live+autonomous director may auto-apply a change **within a bounded rail** (e.g. only a one-tier bump for a worker whose rollup is <7), else it escalates — same north-star supervision as every other tool.
- **P4 — surface on the agent profile ⏳** — each agent profile (`/dashboard/agents/[role]`) shows its current **Model: {tier}** + the change history; the supervisor gets a one-tap Approve on a proposed change. The director's coaching chat ([[worker-grading-and-director-management]] P7) can author a proposal directly ("Fenn's fold quality dropped — propose Sonnet").

## Build status (2026-06-24)
**P1 + P2 shipped** (the foundation — registry, resolver, box wiring, brain pages, seed). `applyModelTierChange` (the single governed write chokepoint P3 will reuse) is in place. **P3 + P4 remain ⏳** — deliberately not built this pass because each spans a complex existing subsystem (P3: the platform-director decision loop + the `approveRoadmapAction` action-execution path + [[../libraries/approval-router]] routing; P4: the [[../dashboard/agents|Agents hub]] `[role]` profile + a new read API + the one-tap-approve + the coaching-chat authoring) **and** carries product decisions the spec leaves open (the auto-apply rail is given only as an *e.g.*; the proposal→action integration pattern and the profile UI placement are unspecified). Resolve those before building P3/P4.

**Apply steps (no prod creds on the box — owner runs):** `npx tsx scripts/apply-agent-model-tiers-migration.ts` then `npx tsx scripts/seed-agent-model-tiers.ts --apply`.

## Verification
- An `agent_model_tiers` row for `kind='fold'='haiku'` makes the box pass `--model` (the haiku id) on the next fold job; an unset kind passes no `--model` (the Max default — no regression).
- A director proposing a model change for a worker creates an `approval_decisions`-logged proposal routed to the supervisor; on approval the registry row updates and the next job of that kind uses the new model.
- A worker whose rollup is <7 on a small model → the director proposes a bump (auto within the rail, else escalated); flipping the row back reverts cleanly.
- The agent profile shows the current model + lets the supervisor approve a pending change.
