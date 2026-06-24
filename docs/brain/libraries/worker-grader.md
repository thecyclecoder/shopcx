# `src/lib/agents/worker-grader.ts` — the worker-action grader

The DevOps Director's **worker-action grade** — one row per graded **concluded `agent_jobs` row**, 1–10 + reasoning ([[../specs/worker-grading-and-director-management]] Phase 1; the devops-director goal "the org learns + self-manages"). One level **down the org chart** from [[director-grader]]: there the CEO grades the Director's calls; here the Director grades each WORKER's actions, and a slip in a worker's rollup triggers a coaching pass. Persists to [[../tables/worker_action_grades]]; calibrated by approved [[../tables/worker_grader_prompts]] rules; coaches via [[worker-instructions]] `coachWorker`.

The defining invariant (inherited from [[director-grader]]): **grade the work, not outcome luck** — a sound, well-scoped action that hit a rare reversible bump still grades well if the reasoning was right; a careless action that happened to land grades low. The grader is a SUPERVISED TOOL ([[../operational-rules]] § North star): it scores a bounded proxy (action quality); the Director owns the objective and the CEO overrides it.

## The gradeable unit
One **concluded `agent_jobs` row** (terminal status `completed｜failed｜needs_attention`) — a build merged, an error fixed/dismissed, an index proposed, a spec verified. The job IS the worker's atomic action, so the director grader's polymorphic key collapses to a single FK (`agent_job_id`) + one rubric per worker `kind`.

## Per-worker rubrics
`WORKER_RUBRICS` (exported) maps each `agent_jobs.kind` → `{name, criteria}` (the spec's locked config): `build`→Bo (spec phases · `tsc` · clean merge), `repair`→Rafa (root-cause · fix held), `regression`→Remi, `db_health`→Devi, `spec-test`→Vera, `migration-fix`→Mira, `pr-resolve`→Pax, `fold`→Fenn, `coverage-register`→Cole, `monitor`→Tao, `plan`→Pia, `product-seed`→Sol, `spec-chat`→Sage, `dev-ask`→Dex. `GRADEABLE_KINDS` = its keys — only rubric-backed kinds are graded (the Director's own + non-worker kinds are excluded).

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `gradeWorkerAction` | `({ agentJobId, admin? }) → Promise<WorkerGradeResult>` | Grade ONE concluded job against its worker's rubric. Concluded-only (`not_concluded` until terminal), rubric-gated (`not_a_gradeable_worker`), idempotent on `agent_job_id`, never clobbers a human grade. |
| `gradeConcludedWorkerActions` | `({ workspaceId, admin?, limit?, cap? }) → Promise<{ considered, graded, gradedKinds }>` | The batched grading pass: grade a **bounded** slice (≤ `cap`, default `GRADE_BATCH_CAP`=12) of the ungraded concluded actions in one session — **failures first**, then a **round-robin-by-worker** random sample of successes (`selectGradingBatch`), so a chatty worker (fold/pr-resolve) can't jam the run and un-selected jobs ride a later beat. Returns the distinct kinds it newly graded (so the caller coaches exactly those). A no-op while none are ungraded. |
| `workerGradingBatchReady` | `(admin, workspaceId, now?) → Promise<{ ready, ungraded }>` | The batched-cadence gate: ready when ≥`BATCH_MIN` (5) ungraded concluded jobs OR the oldest ungraded is >`BATCH_FALLBACK_MS` (~3h). Keeps the LLM spend to one session per batch. |
| `computeWorkerRollup` | `(admin, workspaceId, workerKind) → Promise<WorkerRollup>` | The standing score: last-`ROLLUP_WINDOW` (10) average + `priorAverage` (jobs 11–20) + `drop` (prior − current). |
| `detectGradeDropCoaching` | `({ workspaceId, workerKind, admin? }) → Promise<CoachingTriggerResult>` | The coaching trigger: slip = avg `< COACH_LOW_ROLLUP` (≥3 grades) OR `drop > DROP_THRESHOLD`; on a slip, synthesize a learning from the low grades → `coachWorker` (Director-gated). Loop-guarded. |
| `buildWorkerGraderSystemPrompt` | `(admin, workspaceId, workerKind) → Promise<string>` | The worker's rubric + approved [[../tables/worker_grader_prompts]] rules (worker-targeted + cross-cutting NULL). |

**Constants:** `ROLLUP_WINDOW=10` · `COACH_LOW_ROLLUP=7` · `DROP_THRESHOLD=1.5` · `BATCH_MIN=5` · `BATCH_FALLBACK_MS=~3h` · `GRADE_BATCH_CAP=12`.

**Bounded, prioritized cadence (CEO directive — don't jam the box).** A grading session grades **at most `GRADE_BATCH_CAP`** jobs. Selection (`selectGradingBatch`): **every failure** (`failed`/`needs_attention` — a worker mistake worth coaching on, newest first) up to the cap, then the remaining slots filled by a **round-robin-by-worker** random sample of the successes — so noisy routine workers (fold, pr-resolve) get spot-checked without crowding out quieter ones, and the rest stay ungraded for a later beat. A failure also makes `workerGradingBatchReady` true immediately (graded promptly, not on the ~3h fallback).

## How it grades
- **Inputs:** the concluded job's row — `kind` / `spec_slug` / `status` / `error` / `log_tail` / `pr_url` / the approved `pending_action`. (Phase 1 grades from the job-row context the runtime has; the Phase-2 Max box session that reads the real PR diff is the cadence layer.)
- **Model:** Sonnet ([[ai-models]]). Cost via [[ai-usage]] (`purpose='worker_action_grading'`; the coaching synthesis is `worker_coaching_synthesis`).
- **Output (strict JSON):** `{ grade, reasoning }`, 1–10. The grade weights judgment-within-the-rubric over outcome luck.

## The coaching cascade
`detectGradeDropCoaching` computes the rollup; on a slip it pulls the worker's recent low-graded actions, asks the LLM to distill ONE durable learning (`{errorClass, triggeringPattern, guidance, reasoning}`), and calls [[worker-instructions]] `coachWorker` with `coachedBy=PLATFORM` (the Director is the gate — a worker can't coach itself) + `sourceGradeId`. That amends the worker's instruction set ([[../tables/worker_instructions]]) and logs the director→worker message ([[../tables/worker_coaching_log]]). Loop-guard: ≥`PLATFORM_DIRECTOR_LOOP_GUARD_MAX` coaching attempts that never `stuck` → `needsEscalation` instead of re-coaching (the existing CEO-escalation rail).

## Where it's wired
- **Phase 1 ✅:** the store + grader library + the rollup/coaching trigger.
- **Phase 2 ✅:** the batched cadence — [[../inngest/platform-director-cron]]'s `grade-and-coach-workers` step runs `workerGradingBatchReady` (gate: ≥5 ungraded OR oldest >~3h) → `gradeConcludedWorkerActions` → `detectGradeDropCoaching` per newly-graded worker, on the same `*/15` beat as the director grade sweep, in the deployed runtime (needs the API key). Best-effort + idempotent.
- **Phase 3 ✅:** each worker profile (`/dashboard/agents/[role]`) gets a **rollup-grade card** (last-10 avg + trend) + a **graded-actions feed** (recent concluded jobs each with its grade) via `WorkerGradePanel` ← `GET /api/developer/agents/worker-grades?kind=…` (owner-gated: `computeWorkerRollup` + the recent concluded `agent_jobs` joined to their grades).

## Gotchas
- **Supervised tool** ([[../operational-rules]] § North star) — scores a bounded proxy (action quality); the Director owns the objective, the CEO overrides. The grade only recommends a coaching pass, never a leash change.
- **Concluded-only + rubric-gated** — an in-flight job returns `not_concluded`; a non-worker / Director kind returns `not_a_gradeable_worker`.
- **Idempotent + human-safe** — keyed on the `agent_job_id` unique; a re-run UPDATEs in place, and `graded_by='human'` is never re-written.
- **Best-effort, never blocking** — the sweep is wrapped so a grader failure never breaks the caller; a missing `ANTHROPIC_API_KEY` is a clean no-op.

---

[[../README]] · [[../tables/worker_action_grades]] · [[../tables/worker_grader_prompts]] · [[../tables/worker_coaching_log]] · [[../tables/worker_instructions]] · [[worker-instructions]] · [[director-grader]] · [[platform-director]] · [[../specs/worker-grading-and-director-management]] · [[../goals/devops-director]] · [[../../CLAUDE]]
