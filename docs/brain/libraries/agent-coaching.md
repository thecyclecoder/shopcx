# libraries/agent-coaching

The DevOps Director's **coaching brain** — the supervisory pass that detects a worker's repeated mistakes and acts on them ([[../specs/worker-coaching-loop]], Phase 1). Reads [[../tables/director_activity]], writes via [[worker-instructions]] `coachAgent`, posts to [[director-board]], routes code bugs to [[../specs/repair-agent|Repair]], and escalates to the CEO. Pairs with [[worker-instructions]] (the store) — this is the **detect → route → coach/route/escalate → re-check** logic on top.

**File:** `src/lib/agents/agent-coaching.ts` (server-only). **Runner:** `scripts/run-worker-coaching-pass.ts` (dry-run by default).

## Detection

- **`detectRepeatedErrors(admin, workspaceId, opts?): Promise<RepeatedErrorCandidate[]>`** — group recent [[../tables/director_activity]] by `(worker, disposition class)`. Resolves the worker kind via `metadata.agent_kind` → `metadata.job_id` ([[../tables/agent_jobs]]`.kind`) → the `action_kind`. Returns a candidate for every disposition a worker applied **≥ `REPEAT_ERROR_THRESHOLD`** times in the window, surfacing `recurredSignatures` — **the concrete wrongness signal we trust without the grading loop:** a signature the worker dismissed that **came back** (a correct disposition makes a problem stop). Grades from [[../specs/director-loop-grading]] become an additional input once it ships.
- **`classifyCoachingRoute(candidate): 'guidance-gap' | 'code-bug'`** — a genuine code defect (`real-bug`) is **not** a guidance gap → route to Repair, never an instruction tweak. Misclassification/judgment dispositions (`transient｜foreign｜false-positive｜…`) are coachable.

## The standing pass

- **`runAgentCoachingPass(admin, workspaceId, { apply?, coachAll?, directorFunction? }): Promise<CoachingPassResult>`** — **dry-run by default** (`apply:true` writes). For each **coachable** candidate (one with a recurred-signature signal, unless `coachAll`):
  - **code bug** → `enqueueRepairJob` + a `coaching_routed_to_repair` [[director_activity]] row + a board `update` (kind `code-bug-route`). Never coached.
  - **already coached ≥ `COACHING_ATTEMPTS_BEFORE_ESCALATE`** and still recurring → **escalate to the CEO**: an `escalated_coaching` activity row + a board `update` mentioning `ceo` (kind `escalation`). Never infinite re-coaching.
  - else **coach**: `coachAgent` (amend the instructions + log the message), post the board `update` ("🛠️ Ada coached 🔴 Remi: …"), link the post, write a `coached_worker` activity row.
  - frequency-only candidates (no recurrence) are **surfaced** for director review — never auto-coached (no false coaching).
- **`recheckPendingCoachings(admin, workspaceId, { apply? })`** — for each `pending` coaching, did the `(worker, class)` disposition recur in [[director_activity]] **after** the coaching? → `recurred` (counts toward escalation next pass) else (once ≥1 day old) `stuck`. Run at the top of each pass.

## Blameless box-outage — auto-resolve (skip coaching, no CEO escalation)

A worker's low grade CAN come from the BOX going down mid-run — the Claude CLI drops with `authentication_failed` / `Not logged in` when its account credentials evict, the Claude-down breaker trips (`Claude is down (breaker tripped) — auto-resumes on recovery`), or the same identical box-level runtime error stamps every action in the outage window. That is an INFRA failure — the worker never reached its judgment layer. Coaching such a batch wastes a slot; leaving the coach job parked `needs_attention` mints a CEO [[../tables/dashboard_notifications]] card every cycle while the outage grades age out (the [[../specs/agent-coach-auto-resolves-blameless-box-outage-grade-batches-instead-of-escalating|spec]] this section documents).

Two-part guard, wired inside [[../../scripts/builder-worker.ts]] `runAgentCoachJob` BEFORE the Max box session dispatches:

- **`classifyBlamelessOutageBatch(lows): { blameless, dominantSignature, perGrade, reason }`** — pure classifier over the batch's low grades. Reads each grade's grader `reasoning` + the underlying [[../tables/agent_jobs]]`.error` + `.log_tail`, matches against `BLAMELESS_OUTAGE_SIGNATURES` (`cli_auth_failed` · `cli_not_logged_in` · `cli_login_prompt` · `claude_breaker_tripped` · `breaker_tripped` · `blocked_on_dependency_claude`), and demotes the batch on any `WORKER_ATTRIBUTABLE_MARKERS` hit (wrong disposition · misdiagnosed root cause · false positive/negative · symptom-not-root · rebuild churn). **A batch is blameless-outage iff EVERY low grade matches a box signature AND NONE carries a worker-attributable marker.** One real slip demotes the whole batch back to COACHABLE — an outage co-occurrence never masks a genuine worker mistake.
- **`decideBlamelessOutageOutcome(verdict, recentAuditRows, now?): CoachBatchOutcome`** — pure decision fn. Not blameless → `proceed_to_coach` (the normal coach → route-to-repair → escalate path runs untouched). Blameless with a `blameless_outage` audit row for the same (workspace, agent_kind) inside `BLAMELESS_OUTAGE_DEDUP_MS` (24h) → `auto_resolve_deduped` (mark the coach job `completed` referencing the existing audit id — recurring outage grades aging out do NOT re-mint a card every cycle). Blameless with no recent audit row → `record_blameless_outage` (insert ONE row into [[../tables/agent_coaching_log]] with `kind='blameless_outage'` · `recheck_status='stuck'` since there is nothing to re-check on an outage · `error_class=blameless-outage:{signature}` · `source_activity_ids` = the grade ids that made up the batch).

Either way the coach `agent_jobs` row lands `status='completed'` — **NEVER `needs_attention`** — so the CEO card path never fires. Verification tests: `src/lib/agents/agent-coaching.test.ts` (both pure functions, 16 cases covering the classifier signature vocabulary + every decision branch + the dedup boundary).

## Constants (tunable defaults)

`COACHING_DIRECTOR_FUNCTION='platform'` · `COACHING_WINDOW_DAYS=14` · `REPEAT_ERROR_THRESHOLD=3` · `COACHING_ATTEMPTS_BEFORE_ESCALATE=2` · `BLAMELESS_OUTAGE_DEDUP_MS=24h`.

## Why this exists

The director optimizes a bounded proxy (worker decision quality) and answers to the CEO. Coaching is **reversible guidance within the leash**; a class that won't fix after N coachings **escalates** (a deeper redesign is the CEO's call) — CEO → director → worker, never a silent proxy-optimizer ([[../operational-rules]] § North star). Until the Platform director box lane runs this on its standing cadence ([[../specs/director-loop-grading]] M5), an owner/cron runs `scripts/run-worker-coaching-pass.ts`; the same library is what the live director calls.

## Related

**Above this layer:** [[agent-kpis]] surfaces coaching activity in every agent's **Quality** tier (a coaching-count card) and — for Cleo (`storefront-optimizer`) — is what the KPI page uses to answer *"is this agent LEARNING?"* alongside the grade rollup. See `/dashboard/agents/[role]/kpi`.

[[worker-instructions]] · [[../tables/agent_instructions]] · [[../tables/agent_coaching_log]] · [[../tables/director_activity]] · [[director-board]] · [[repair-agent]] · [[agent-kpis]] · [[../specs/worker-coaching-loop]] · [[../specs/platform-director-agent]] · [[../specs/director-loop-grading]] · [[../goals/devops-director]]
