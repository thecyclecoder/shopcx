# `src/lib/agents/worker-grader.ts` — the worker-action grader

The DevOps Director's **worker-action grade** — one row per graded **worker action**, 1–10 + reasoning ([[../specs/worker-grading-and-director-management]] P1). One level **down the org chart** from [[director-grader]]: there the CEO grades the [[../specs/platform-director-agent|Platform/DevOps Director]]'s own CALLS; here the Director (Ada) grades each [[../tables/agent_jobs|worker]]'s concluded actions — and a slipping standing rollup triggers a coaching pass ([[worker-coaching]] `coachWorker`). Persists to [[../tables/worker_action_grades]]; calibrated by approved [[../tables/worker_grader_prompts]] rules.

The defining invariant (inherited from [[director-grader]]): **craft is scored separately from outcome** — a worker whose disposition was sound but hit a rare external bump still grades well; a clean outcome reached by luck while skipping the work grades low. The grader is a **supervised tool** ([[../operational-rules]] § North star): it scores a bounded proxy (action quality); the Director owns the objective and overrides it.

## The gradeable unit
ONE concluded [[../tables/agent_jobs]] row — the worker's atomic action. Concluded = a terminal status (`completed｜failed｜needs_attention`); an in-flight job returns `not_concluded` and is retried next batch. Idempotent on `agent_job_id`; never clobbers a human grade.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `gradeWorkerAction` | `({ agentJobId, admin? }) → Promise<WorkerGradeResult>` | Grade ONE concluded job. Concluded-only (`not_concluded` until terminal); idempotent on `agent_job_id`; never clobbers a human grade. |
| `gradeConcludedWorkerActions` | `({ workspaceId, admin?, limit? }) → Promise<{ considered, graded }>` | The **batched** grading sweep: grade every concluded, ungraded job in ONE session (not one-per-session — keeps box cost bounded; capped at `GRADING_BATCH_CAP`=60). Fired on the P2 cadence. A no-op when nothing is ungraded. |
| `computeWorkerRollup` | `({ workspaceId, workerKind, admin? }) → Promise<WorkerRollup>` | The standing score: the **last-10** average + the prior-10 trend (`drop` = priorAvg − avg; a positive `drop` is a fall) + the worst recent grade/reasoning (the concrete coaching signal). |
| `detectGradeDropCoaching` | `({ workspaceId, admin?, apply?, directorFunction? }) → Promise<GradeDropResult>` | rollup **< 7** OR a **> 1.5 drop** → `coachWorker` (amend instructions on class `grade-rollup-slip` + board post + activity); already coached ≥ `COACHING_ATTEMPTS_BEFORE_ESCALATE` times and still slipping → **escalate to the CEO** (loop-guard). dry-run by default; `apply:true` writes. Skips a thin window (< `MIN_GRADES_FOR_COACHING`=5). |
| `buildWorkerGraderSystemPrompt` | `(admin, workspaceId, workerKind) → Promise<string>` | The generic frame + the per-worker `RUBRICS` entry (the spec's rubric table) + approved [[../tables/worker_grader_prompts]] rules (global or worker-matched). |

## How it grades
- **Inputs:** the job's kind / spec / instructions / gated action / terminal status / PR / error / log tail, plus a **repeat-failure count** (later `failed`/`needs_attention` jobs of the same spec after this one — the "did it hold up" signal).
- **Per-worker rubric:** the `RUBRICS` map encodes the spec's "what good = 10 means" table (Bo/`build`: phases satisfied · tsc clean · merged clean · no rebuild churn; Rafa/`repair`: real root-cause · fix held · noise dismissed · scoped; …). The CEO calibrates on top via [[../tables/worker_grader_prompts]].
- **Model:** Sonnet ([[ai-models]]). Cost via [[ai-usage]] (`purpose='worker_action_grading'`).
- **Output (strict JSON):** `{ grade, reasoning }`, grade 1–10 — the reasoning keeps craft vs outcome distinct. The grade weights craft ≥ outcome.

## Tunable config (the locked rubric — tune HERE, not in tribal memory)
`ROLLUP_WINDOW=10` · `LOW_ROLLUP_THRESHOLD=7` · `GRADE_DROP_THRESHOLD=1.5` · `MIN_GRADES_FOR_COACHING=5` · `GRADING_BATCH_CAP=60` · `GRADE_ROLLUP_CLASS='grade-rollup-slip'`. The supervising director + escalate-after-N come from [[worker-coaching]] (`COACHING_DIRECTOR_FUNCTION='platform'`, `COACHING_ATTEMPTS_BEFORE_ESCALATE=2`).

## Where it's wired
- **Grading + coaching** — the **P2** batched box trigger (≥5 ungraded concluded jobs OR a ~3h fallback) runs `gradeConcludedWorkerActions` then `detectGradeDropCoaching` on the same beat; wired into [[../inngest/platform-director-cron]] + the box runner. The LLM grading runs on the box (reads the real PR/diff/spec), needing `ANTHROPIC_API_KEY`; a missing key is a clean no-op.
- **The coaching write** — `detectGradeDropCoaching` calls [[worker-coaching]] `coachWorker` (the director-gated amend), posts to [[director-board]], records a [[../tables/director_activity]] row (`coached_grade_drop` / `escalated_grade_drop`).
- **Report** — each worker profile (`/dashboard/agents/[role]`, P3) shows the last-10 rollup card + the grade trend.

## Gotchas
- **Supervised tool** ([[../operational-rules]] § North star) — scores a bounded proxy (action quality); the Director owns the objective and the CEO overrides it. The rollup only *recommends* coaching.
- **Concluded-only** — a job is not graded until it terminates; an in-flight job returns `not_concluded` and is retried next batch.
- **Idempotent + human-safe** — keyed on `agent_job_id`; a re-run UPDATEs in place, and `graded_by='human'` is never re-written.
- **Batched, not per-job** — `gradeConcludedWorkerActions` grades the whole accumulated batch in one session (P2), capped at `GRADING_BATCH_CAP`, so box cost stays bounded.
- **Best-effort, never blocking** — the sweep is wrapped so a grader failure never breaks the cron; thin windows (< `MIN_GRADES_FOR_COACHING`) are skipped (no coaching off one bad grade).

---

[[../README]] · [[../tables/worker_action_grades]] · [[../tables/worker_grader_prompts]] · [[director-grader]] · [[worker-coaching]] · [[worker-instructions]] · [[../inngest/platform-director-cron]] · [[../specs/worker-grading-and-director-management]] · [[../goals/devops-director]] · [[../../CLAUDE]]
