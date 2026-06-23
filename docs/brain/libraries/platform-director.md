# libraries/platform-director

The **Platform/DevOps Director agent** — the **first live director** ([[../specs/platform-director-agent]] Phase 1, [[../goals/devops-director]] M4). Investigate every Approval Request **routed to Platform** and either **auto-approve within the leash** (with the reasoning logged) or **leave it for the CEO**. It **supervises** the existing platform tools ([[../specs/repair-agent|repair]], [[../specs/db-health-agent|db-health]], [[../specs/coverage-auto-register-agent|coverage-register]]) — it does **not** rebuild them.

**File:** `src/lib/agents/platform-director.ts`

## Why this exists

North star ([[../operational-rules]] § supervisable autonomy): **CEO → Director → tool**. Platform's tools already work, but nothing supervised them *as a director* — every platform approval the CEO rubber-stamps landed in the CEO inbox. This module is the supervisor: it reuses the [[../specs/approval-routing-engine|approval-routing]] plumbing rather than adding a parallel approval path, and records every call to the supervisable-autonomy ledger so the CEO can audit **what** it decided and **why** — in history, never in the queue.

**Dormant until activation.** Until Platform's [[../tables/function_autonomy]] flag is flipped `live + autonomous` (owner-confirmed, [[../specs/platform-director-agent]] Phase 4), [[approval-router]] `resolveApprover` routes nothing here, so the enqueuer is a no-op — the machinery is built but inert.

## The leash (what it MAY auto-approve)

The `goals/devops-director` § leash + the standing autonomy rule ([[../operational-rules]]). A **structural** gate (which action class) **and** a **soundness** gate (the read-only investigation — *never rubber-stamps*):

| `LeashCategory` | Pending-action `type` | What |
|---|---|---|
| `error_fix` | `repair_build` | a repair-agent fix for a real bug |
| `db_health` | `db_health_build` | a DB index / health fix (no destructive DDL) |
| `additive_migration` | `apply_migration` | an **additive, reversible** migration (no DROP/DELETE/data loss) |
| `monitoring_fix` | *(reserved)* | a platform-monitoring registry fix |

**Always escalates** (never auto-approves): destructive/irreversible actions, modifying/abandoning a goal, starting a new goal, multi-choice decisions (coverage-register register-vs-exempt, hero preview), or anything it cannot confirm sound. Loop-guard + **CEO escalation routing** is Phase 3 — in Phase 1 a non-leash request is left untouched (stays `needs_approval`) and logged as `escalated`.

## Escorting goals (Phase 2 — milestone progression within the leash)

`escortApprovedGoals` drives each **approved** goal the director owns forward, **leaning on the existing machinery** ([[../specs/spec-blockers|blocked_by auto-queue]] `autoQueueUnblockedBy` + the builder chain + auto-ship + fold) rather than reimplementing it. The reactive auto-queue fires on a *blocker's merge*; the escort is the **proactive** complement — a throttled box sweep (~5 min) that kicks off the unblocked specs the reactive path never caught and **logs the advance**.

- **Approved goal** = `GoalCard.owner === platform` (new `Owner: [[../functions/x]]` parse in [[brain-roadmap]] `parseGoal`) with **real progress** `0 < pct < 100`. A zero-progress goal is *unstarted* — auto-starting it would be "starting a new goal," which always escalates to the CEO (Phase 3), so the escort never touches it. No goal-approval flag exists in the DB; progress is the proxy for "already greenlit."
- **What it queues:** every spec linked across the goal's milestones that is **unshipped + unblocked** (all `blockedBy` cleared) + has **no build job yet**, as a `kind='build'` `agent_jobs` row (`created_by=null` — the same agent-enqueue shape as `autoQueueUnblockedBy` / `queueNextChainedPhase`, so the chain/auto-ship/fold pick it up unchanged). Skips blocked specs (the reactive auto-queue handles those on their blocker's merge) and `**Auto-build:** off` opt-outs.
- **Audited + idempotent:** one `escorted_goal` [[../tables/director_activity]] row per goal it advances (`autonomous=true`, naming the goal + queued slugs); a spec that already has a build job is **confirmed in-flight**, never re-queued. **Dormant** (a no-op) until Platform is live+autonomous (Phase 4), exactly like the approval enqueuer.

## Exports

- **`enqueuePlatformDirectorJobs(admin)`** → `{ enqueued, slugs }` — the poll-loop background sweep. Finds every open `needs_approval` [[../tables/agent_jobs]] routed to Platform and queues one `kind='platform-director'` job per target (instructions `{ target_job_id, target_kind }`). **Idempotent** (one director job per target, ever — the dedup that stops an infinite re-enqueue of a deferred target). No-op unless `platformIsAutoApprover`.
- **`directorLeashCandidate(job)`** → `{ actionId, category } | null` — the structural gate. Reuses [[approval-inbox]] `inlineApproveActionId` (single, plain approve/decline — not multi-choice) and adds the leash-type filter. `null` ⇒ outside the envelope ⇒ escalate.
- **`buildDirectorBrief(job, candidate)`** / **`directorInvestigationPrompt(brief)`** — the read-only Max `claude -p` investigation prompt (the cause + proposed fix inline → one JSON verdict `auto-approve｜escalate`).
- **`applyDirectorApproval(admin, target, actionId, reasoning)`** → `{ ok, error? }` — the **autonomous approve** path. Mirrors [[roadmap-actions]] `approveRoadmapAction` **without** the owner gate: marks the action `approved`, flips the job to `queued_resume` when none stay pending (**execution path unchanged**), then writes the [[../tables/approval_decisions]] row via [[approval-decisions]] `recordApprovalDecision` (`decided_by='director'`, `autonomous=true`).
- **`platformIsAutoApprover(autonomy)`** / **`routesToPlatform(kind, chart, autonomy)`** — routing predicates over [[approval-router]].
- **`escortApprovedGoals(admin)`** → `{ goals, queued }` (Phase 2) — the proactive goal-escort sweep (see *Escorting goals* above). No-op until live+autonomous; queues unblocked specs of approved goals the director owns + logs `escorted_goal`. Driven by a throttled `scripts/builder-worker.ts` poll-loop sweep alongside `enqueuePlatformDirectorJobs`.
- Const **`PLATFORM`**, **`LEASH_CATEGORIES`**; types **`LeashCategory`**, **`DirectorTargetJob`**, **`DirectorActionLike`**, **`DirectorBrief`**, **`GoalEscortResult`**.

## The box lane

`scripts/builder-worker.ts` `runPlatformDirectorJob` (concurrency-1 `platform-director` lane, claimed via `claim_agent_job`; `runDirectorClaude` is the Max session — read-only DB creds kept, API key stripped). It re-loads the target, **re-confirms** it still `needs_approval` and still routes to Platform (fail-safe), runs the leash gate, investigates read-only, then:
- **`auto-approve`** → `applyDirectorApproval` + a `director_activity` `approved_approval` row ([[../tables/director_activity]]).
- **`escalate`** (or any ambiguous/unparseable verdict — fail safe) → leaves the target untouched + a `director_activity` `escalated` row. CEO routing lands in Phase 3.

It **never** edits product code, opens a PR, or runs a migration — it only decides on the existing gated action.

## Safety invariants

- **Never rubber-stamps** — a structural leash candidate must *also* pass the investigation verdict; an ambiguous/errored result escalates, never approves.
- **The leash is hard** — destructive/irreversible, goal-touching, new-goal, and multi-choice requests always escalate.
- **Execution path unchanged** — the autonomous approve flips the same `queued_resume` the human path does; no action runs by a path that skips the gate.
- **Auditable** — every call (approve or escalate) logs reasoning to [[../tables/approval_decisions]] / [[../tables/director_activity]].

## Related

[[../specs/platform-director-agent]] · [[../goals/devops-director]] · [[approval-router]] · [[approval-inbox]] · [[approval-decisions]] · [[../tables/agent_jobs]] · [[../tables/approval_decisions]] · [[../tables/function_autonomy]] · [[../tables/director_activity]] · [[../operational-rules]] (§ North star)
