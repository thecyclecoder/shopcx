# inngest/playbook-compiler

Weekly **enqueuer** for the playbook-compiler box agent. Fires the box lane `playbook-compile` (`scripts/builder-worker.ts` → `runPlaybookCompileJob`) once per workspace with mineable history — the box lane mines the FULL corpus (tickets + [[../tables/ticket_analyses]], no 30-day floor) and persists recurring problem-to-resolution trees to [[../tables/compiled_trees]]. Phase 1 of [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]].

**File:** `src/lib/inngest/playbook-compiler.ts` (thin enqueuer) · library in [[../libraries/playbook-compiler]] · agent skill at `.claude/skills/playbook-compile/SKILL.md` · runner in `scripts/builder-worker.ts` `runPlaybookCompileJob`.

Superseded shape: this cron used to be a Sonnet-drafting sweep that mined only the 30-day `ticket_resolution_events` ledger and inserted `sonnet_prompts` rows. That path is **gone** — no raw external model API call is made from ShopCX for this loop. See [[../operational-rules]] § No-Fable-no-raw-API and [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]] Phase 1.

## Functions

### `playbook-compiler`
- **Triggers:**
  - cron `0 12 * * 1` — Mondays 12:00 UTC (7 AM Central during CDT, 6 AM CST). Weekly cadence gives admins a predictable time to see fresh trees in [[../tables/compiled_trees]] for Phase 2 to propose playbook seeds from.
  - event `playbook-compiler/run` — manual invocation for out-of-band enqueues, e.g. right after a burst of new [[../tables/ticket_analyses]] lands.
- **Concurrency:** `[{ limit: 1 }]`.
- **Retries:** 1.

## Loop

1. **Enumerate** workspaces with any mineable history via [[../libraries/playbook-compiler]] `listCompilableWorkspaces` (any `ticket_analyses` row OR any confirmed `ticket_resolution_events` row).
2. Per workspace:
   1. **Skip empty history** — no analyses + no confirmed resolutions → the workspace has nothing to mine yet.
   2. **Dedupe** on active job — if an `agent_jobs` row of kind `playbook-compile` already exists in `{queued, queued_resume, claimed, building, needs_input, needs_approval, blocked_on_usage}`, skip this pass (an in-flight sweep is enough).
   3. **Enqueue** one `agent_jobs` row (`kind='playbook-compile'`, `spec_slug=''`, `spec_branch=null`, `status='queued'`, `instructions=JSON stats blob`).
3. **Emit heartbeat** via [[../libraries/control-tower]] `emitCronHeartbeat` (control-tower-complete-coverage spec, Phase 1).

## Downstream

- `playbook-compile` `agent_jobs` rows are drained by `scripts/builder-worker.ts`'s dedicated concurrency-1 lane (`MAX_PLAYBOOK_COMPILE = 1`). The runner reads the FULL history via `loadPlaybookCompileBrief`, dispatches a Max `claude -p` (playbook-compile skill) that emits ONE JSON verdict `{trees, reasoning}`, and upserts each tree via `applyBoxPlaybookCompile`.
- `playbook-compiler/run` — the manual trigger this same function accepts. Sending from an admin one-off will fan a fresh sweep.

## Tables read (not written)

- [[../tables/ticket_analyses]] — one source of the enumeration (any row → the workspace is mineable).
- [[../tables/ticket_resolution_events]] — the other source (any `verified_outcome='confirmed'` row → mineable).
- [[../tables/agent_jobs]] — for the "active job exists" dedupe.

## Tables written

- [[../tables/agent_jobs]] — one `kind='playbook-compile'` row per mineable workspace per pass (unless deduped).

The DOWNSTREAM writes (per-run) are made by the box lane, NOT this cron:
- [[../tables/compiled_trees]] — the persisted trees, upserted by `applyBoxPlaybookCompile`.
- [[director_activity]] — one `action_kind='compiled_trees_extracted'` row per run (`director_function='cs'`).

## Invariants

- **The cron never calls a raw model API.** It's a thin enqueuer; the LLM lives in the box lane.
- **One in-flight job per workspace.** The active-status dedupe means a Monday cron sweep never fans a second row on top of a manually-triggered `playbook-compiler/run` still running.
- **Empty history → no-op.** A workspace with no `ticket_analyses` and no confirmed `ticket_resolution_events` is skipped — the cron never enqueues an empty-work job.

## Related

- Parent spec: [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]] — Phase 1 (this + the box lane), Phase 2 (proposed `playbooks` + `playbook_steps` off `compiled_trees`), Phase 3 (Sol M4 selection wires the compiled library into the direction-setting session).
- Library: [[../libraries/playbook-compiler]] — the read/write chokepoints the runner + cron share.
- Store: [[../tables/compiled_trees]] — the durable substrate the box lane populates.

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
