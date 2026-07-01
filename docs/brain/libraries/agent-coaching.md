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

## Constants (tunable defaults)

`COACHING_DIRECTOR_FUNCTION='platform'` · `COACHING_WINDOW_DAYS=14` · `REPEAT_ERROR_THRESHOLD=3` · `COACHING_ATTEMPTS_BEFORE_ESCALATE=2`.

## Why this exists

The director optimizes a bounded proxy (worker decision quality) and answers to the CEO. Coaching is **reversible guidance within the leash**; a class that won't fix after N coachings **escalates** (a deeper redesign is the CEO's call) — CEO → director → worker, never a silent proxy-optimizer ([[../operational-rules]] § North star). Until the Platform director box lane runs this on its standing cadence ([[../specs/director-loop-grading]] M5), an owner/cron runs `scripts/run-worker-coaching-pass.ts`; the same library is what the live director calls.

## Related

**Above this layer:** [[agent-kpis]] surfaces coaching activity in every agent's **Quality** tier (a coaching-count card) and — for Cleo (`storefront-optimizer`) — is what the KPI page uses to answer *"is this agent LEARNING?"* alongside the grade rollup. See `/dashboard/agents/[role]/kpi`.

[[worker-instructions]] · [[../tables/agent_instructions]] · [[../tables/agent_coaching_log]] · [[../tables/director_activity]] · [[director-board]] · [[repair-agent]] · [[agent-kpis]] · [[../specs/worker-coaching-loop]] · [[../specs/platform-director-agent]] · [[../specs/director-loop-grading]] · [[../goals/devops-director]]
