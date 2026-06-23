# Director continuous loop + grading ⏳

**Owner:** [[../functions/platform]] · **Parent:** M5 — Continuous loop + grading
**Blocked-by:** [[platform-director-agent]]

The supervisory loop that closes the **CEO → Director → tool** chain for the [[../goals/devops-director]] goal. The [[platform-director-agent|Platform/DevOps Director]] runs on a **standing cadence** (a scheduled pass), and the CEO **grades the director's calls 1–10** — *was the auto-approval right? did the escorted goal land clean?* — and those grades **train it and tighten/loosen the leash**. This directly mirrors the shipped [[storefront-campaign-grading-loop|Head-of-Growth campaign-grading loop]] (an AI/human grader against a rubric + human-approved calibration rules, human-overridable, feeding back as a training signal) — reusing its proven shape one level up the org chart. Today the leash in the goal is **static**: the [[platform-director-agent|M4 director]] auto-approves within a fixed policy with no feedback loop that widens or narrows the [[approval-routing-engine|`live + autonomous`]] envelope based on whether its past calls were good. Success metric served: **% of platform approvals the CEO never touches** can *safely* trend up because the director's decision quality is measured and the autonomy envelope is earned, not assumed.

## Phase 1 — the standing cadence ✅
- ✅ shipped
- A scheduled Platform-Director pass (a cron enqueueing the [[platform-director-agent|`platform-director`]] [[../tables/agent_jobs]] kind, registered in `MONITORED_LOOPS` per [[coverage-auto-register-agent]] so it can't silently die), in addition to the event-driven processing — so escorting + watching happen on a reliable beat, not only on inbound approvals. Mirror [[../inngest/daily-analysis-report-cron]]'s cron shape.

**Shipped:** `src/lib/inngest/platform-director-cron.ts` — a daily cron (`15 12 * * *`, mirroring [[../inngest/daily-analysis-report-cron]]) that inserts one `queued` `agent_jobs` row `kind='platform-director'` per build-console workspace (any workspace with an agent_jobs row, like [[../inngest/spec-test-cron]]), deduped against in-flight platform-director jobs — no daily pileup. Registered in the Inngest serve list (`src/lib/inngest/registered-functions.ts`) and in `MONITORED_LOOPS` (`src/lib/control-tower/registry.ts`, `owner: platform`, 26h window + `registeredAt` first-tick grace) so a dead cadence surfaces on Control Tower. End-of-run `emitCronHeartbeat`. Brain page [[../inngest/platform-director-cron]]. Free-text `platform-director` agent_jobs kind — no migration. The box lane that *processes* the enqueued job (`runPlatformDirectorJob`) is [[platform-director-agent]]'s deliverable.

## Phase 2 — the director-decision grade store + rubric ✅
- ✅ shipped
- `director_decision_grades` (columns: `id`, `approval_decision_id` (→ [[../tables/approval_decisions]]) or `goal_slug`/`milestone`, `dimension` ∈ `auto-approval｜goal-escort`, `grade` (1–10), `reasoning`, `graded_by` ∈ `agent｜human`, `overridden_by`, `created_at`) — one row per graded call. Brain page [[../tables/director_decision_grades]] (probe live schema first per [[../README]]).
- A grading rubric calibrated by **human-approved rules** in a `director_grader_prompts` store modeled on [[../tables/grader_prompts]] (`status` ∈ `proposed｜approved`) — so the CEO corrects the grader's scoring on edge cases, exactly as the ticket/campaign graders are calibrated.

**Shipped (code-complete, tsc-clean; migration NOT yet applied to prod):** `supabase/migrations/20260704120000_director_decision_grades.sql` — two tables mirroring the storefront/acquisition grade stores, one level up the org chart:
- [[../tables/director_decision_grades]] — one row per graded director **call**, keyed by `dimension` ∈ `auto-approval｜goal-escort`: an auto-approval row carries `approval_decision_id` (→ [[../tables/approval_decisions]]); a goal-escort row carries `goal_slug`+`milestone` (the goal lives in `docs/brain/goals`, no FK). A `director_decision_grades_key_shape` CHECK enforces exactly-one key per dimension. `grade` (1–10 CHECK) + `reasoning`, `graded_by` ∈ `agent｜human`, override provenance (`overridden_by`→`auth.users`, `override_reason`, `overridden_at`), + model/token accounting. **Idempotent** via two partial uniques: `(approval_decision_id)` and `(workspace_id, goal_slug, milestone) where dimension='goal-escort'` — a re-grade UPDATEs in place. Indexed `(workspace_id, created_at desc)` + `(workspace_id, dimension, created_at desc)` for the Phase-4 per-dimension report/trend.
- [[../tables/director_grader_prompts]] — the human-approved calibration store (`status` ∈ `proposed｜approved｜rejected｜archived`, `derived_from_decision_id`/`derived_from_grade_id`), modeled on [[../tables/grader_prompts]] — only `approved` rules calibrate the Phase-3 grader.
- RLS mirrors [[../tables/approval_decisions]] (the ledger this grades): authenticated SELECT (the Agents-hub report is owner-gated above the DB), service-role write. Apply via `scripts/apply-director-decision-grades-migration.ts` (idempotent). The LLM grader that writes these rows is `src/lib/agents/director-grader.ts` — **Phase 3**.

## Phase 3 — grade the two dimensions ⏳
- ⏳ planned
- `src/lib/agents/director-grader.ts` `gradeDirectorCall(decision, dimension)` — an LLM grader ([[../libraries/ai-models]]) over (a) each **auto-approval** (was the cause+fix actually sound and within the leash? did it hold up — no rollback/repeat-failure after?) and (b) each **escorted goal/milestone** (did it land clean — merged, tsc/CI green, no regression?). Returns a 1–10 grade + reasoning, human-overridable (records `graded_by='human'`/`overridden_by`), mirroring [[storefront-campaign-grading-loop]]'s grader.
- Fired on the M1 cadence over recently-concluded decisions; idempotent per decision.

## Phase 4 — feed grades back to tighten/loosen the leash ⏳
- ⏳ planned
- Grades **train the director**: a sustained high grade in a category widens its autonomy envelope (the CEO can promote a previously-escalated low-risk category into the auto-approve leash); a low grade narrows it (a category reverts to CEO-gated). The recommendation surfaces as an owner-confirmed change to Platform's [[approval-routing-engine|`live + autonomous`]] / leash policy — **the CEO disposes; the loop never widens its own envelope unilaterally** ([[../operational-rules]] § North star).
- Surface per-period grades + trend + the leash-adjustment recommendations on the M1 Agents hub / M3 board (the CEO's report contract for the director).

## Phase 5 — the human-readable EOD recap + detail page ⏳
- ⏳ planned
- The standing cadence emits a **daily EOD recap**: a one-line standup post to the [[directors-board-gamified|#directors board]] (*"Shipped 8 specs · advanced 1 goal · fixed 2 bugs · approved 4 migrations"*) **plus its own human-readable detail page** (in the M1 Daily Summaries tab) — a readable narrative of the director's day (what it fixed + why, which goal it moved + how far, what it escalated), generated by reading that day's [[../tables/director_activity]] rows. The recap is a **query over the activity log**, never hand-maintained.
- **Future (not this spec):** once the CEO is automated, it reads across *all* directors' `director_activity` into a single CEO roll-up report — design later.

## Safety / invariants
- **Decision graded on soundness, not luck.** A sound auto-approval that later needed a (rare, reversible) tweak still grades well if the *reasoning* was right; a careless approval that happened to be fine grades low — mirror [[storefront-campaign-grading-loop]]'s hypothesis-vs-result separation.
- **Human-overridable + calibrated.** Every grade can be overridden by the CEO; overrides record (`graded_by`/`overridden_by`) and become calibration rules — never silently lost.
- **The leash widens only by the CEO.** Grades *recommend* tightening/loosening; the actual `live + autonomous` / leash change is an owner-confirmed action — the director never expands its own authority ([[../operational-rules]] § North star).
- **Idempotent grading.** A decision is graded once per dimension; a re-run updates in place, never duplicates.
- **The grader is a supervised tool.** It scores a bounded proxy (decision quality); the CEO owns the objective and overrides it.

## Completion criteria
- A standing Platform-Director cadence runs on a registered, monitored schedule.
- `director_decision_grades` + a `director_grader_prompts` calibration store exist (typed, RLS'd, brain pages written).
- Every concluded director call (auto-approval + goal-escort) gets a 1–10 grade with reasoning, human-overridable + recorded.
- Grades feed back as leash-adjustment recommendations the CEO confirms (widen/narrow Platform's autonomy envelope) — the director never self-promotes.
- A report surface shows per-period grades + trend + recommendations; cross-linked from [[../goals/devops-director]].

## Verification
- **(Phase 1 ✅)** Confirm `platform-director-cron` (daily `15 12 * * *`) is in the Inngest serve list and registered in `MONITORED_LOOPS` (`owner: platform`) → on `/dashboard/developer/control-tower` it shows a **live Platform tile** "Platform Director cadence" with no "Unregistered loop" amber gap. After a daily tick → `select kind, status, count(*) from agent_jobs where kind='platform-director' group by 1,2;` → one `queued` row per build-console workspace; re-run the cron same-day while one is in-flight → expect **no duplicate** (dedupe on queued/queued_resume/building/claimed).
- **(Phase 2 ✅)** Apply first: `npx tsx scripts/apply-director-decision-grades-migration.ts` → expect `✓ tables present: [ 'director_decision_grades', 'director_grader_prompts' ]`. In the DB, `\d director_decision_grades` shows the `dimension` + `grade` (1–10) + `graded_by` CHECKs, the `director_decision_grades_key_shape` CHECK, and both partial uniques (`…_approval_uniq`, `…_goal_uniq`). Insert a row with `dimension='auto-approval'` but a non-null `goal_slug` → the `key_shape` CHECK **rejects** it; same for `dimension='goal-escort'` with an `approval_decision_id`. Insert two `auto-approval` rows with the same `approval_decision_id` → the second **fails** the partial unique (idempotent grading).
- After the director auto-approves a call, on the next grading pass → `select grade, reasoning, graded_by from director_decision_grades where approval_decision_id='<id>';` → a 1–10 grade + reasoning, `graded_by='agent'`; re-run → updated in place, not duplicated.
- Grade a sound-but-later-tweaked auto-approval vs a careless-but-fine one → expect the sound call to grade higher (soundness over luck).
- Override a grade in the report surface → `select graded_by, overridden_by from director_decision_grades where id='<id>';` → `graded_by='human'`, `overridden_by=<member>`; a ≥N-point gap proposes a `director_grader_prompts` rule (`status='proposed'`).
- After a sustained high grade in a category, expect a **leash-loosen recommendation** to surface for owner confirmation — and confirm the envelope does NOT change until the owner acts (no self-promotion).
