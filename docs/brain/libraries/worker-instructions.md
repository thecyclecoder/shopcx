# libraries/worker-instructions

The per-worker **instruction store** library — the runtime load + the **director-gated coach write path** ([[../specs/worker-coaching-loop]], Phase 1). Reads/writes [[../tables/worker_instructions]] + [[../tables/worker_coaching_log]]. This is the data layer that makes **coaching a data write, not a deploy**.

**File:** `src/lib/agents/worker-instructions.ts` (server-only — service-role admin client).

## The runtime load (every worker run)

- **`loadWorkerInstructions(admin, workspaceId, workerKind): Promise<WorkerInstruction[]>`** — a worker's `status='active'` guidance, newest-first. Best-effort: `[]` if the table is absent (a runtime caller never crashes on a missing migration).
- **`formatWorkerInstructions(instructions): string`** — render the active guidance as a prompt block ("## Coaching guidance … obey these") or `""` when there are none.
- **`appendWorkerInstructions(admin, workspaceId, workerKind, basePrompt): Promise<string>`** — the **one helper a worker run calls**: load → format → append to the base prompt (unchanged when there's no guidance). Wired into `scripts/builder-worker.ts` `runRepairJob` + `runRegressionJob` (the LLM workers) right before the `claude -p` call.

## The director-gated coach write path

- **`coachWorker(admin, input): Promise<{ instruction, coaching, attempt }>`** — amend a worker's instruction set: insert a new **active** [[../tables/worker_instructions]] row (superseding any prior active row for the same `error_class`, bumping `version`), retire the prior, and log the director→worker message to [[../tables/worker_coaching_log]] (the old→new diff, the triggering pattern, the source activity ids, the attempt count). **Director-gated:** `input.coachedBy` (the supervising director's slug) is **required** — throws without it. `input = { workspaceId, workerKind, coachedBy, errorClass, guidance, triggeringPattern, reasoning, sourceActivityIds?, sourceGradeId? }`. Throws on a write error (the caller decides recovery). The board post + [[director_activity]] write are done by the **caller** ([[worker-coaching]] `runWorkerCoachingPass`), keeping this a pure data write any host can reuse.
- **`linkCoachingBoardPost(admin, coachingId, boardMessageId)`** — stamp the #directors board post id onto the coaching row after the caller posts it.
- **`revertCoaching(admin, instructionId)`** — flip an amendment to `status='reverted'` (it stops being loaded). Coaching is reversible by design.
- **`recordRecheck(admin, coachingId, 'stuck'|'recurred')`** — write the post-coaching re-check verdict.

## Reads for the surfaces

- **`getWorkerCoachingHistory(admin, workspaceId, workerKind, limit=50): Promise<WorkerCoachingEntry[]>`** — a worker's coaching history newest-first. Backs `GET /api/developer/agents/coaching?kind=…` → the profile page's "Coaching history" section.

## Types

- **`WorkerInstruction`** — a camelCased [[../tables/worker_instructions]] row.
- **`WorkerCoachingEntry`** — a camelCased [[../tables/worker_coaching_log]] row.

## Why this exists

The worker NEVER edits its own instructions — only its director coaches it (north-star CEO → director → worker). Enforced two ways: `coachWorker` requires a `coachedBy` director slug, and the tables are **service-role-write-only**. See [[../operational-rules]] § North star.

## Related

[[../tables/worker_instructions]] · [[../tables/worker_coaching_log]] · [[worker-coaching]] · [[director-activity]] · [[director-board]] · [[../specs/worker-coaching-loop]] · [[../goals/devops-director]]
