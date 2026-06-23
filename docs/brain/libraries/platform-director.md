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

**Always escalates** (never auto-approves): destructive/irreversible actions, modifying/abandoning a goal, starting a new goal, multi-choice decisions (coverage-register register-vs-exempt, hero preview), or anything it cannot confirm sound. **CEO escalation routing** is live (Phase 3): an escalation now **re-routes** the Approval Request to the CEO inbox carrying Ada's diagnosis (`escalateApprovalRequestToCeo`), instead of leaving it untouched. See *Loop-guard + CEO escalation* below.

## Escorting goals (Phase 2 — milestone progression within the leash)

`escortApprovedGoals` drives each **approved** goal the director owns forward, **leaning on the existing machinery** ([[../specs/spec-blockers|blocked_by auto-queue]] `autoQueueUnblockedBy` + the builder chain + auto-ship + fold) rather than reimplementing it. The reactive auto-queue fires on a *blocker's merge*; the escort is the **proactive** complement — a throttled box sweep (~5 min) that kicks off the unblocked specs the reactive path never caught and **logs the advance**.

- **Approved goal** = `GoalCard.owner === platform` (new `Owner: [[../functions/x]]` parse in [[brain-roadmap]] `parseGoal`) with **real progress** `0 < pct < 100`. A zero-progress goal is *unstarted* — auto-starting it would be "starting a new goal," which always escalates to the CEO (Phase 3), so the escort never touches it. No goal-approval flag exists in the DB; progress is the proxy for "already greenlit."
- **What it queues:** every spec linked across the goal's milestones that is **unshipped + unblocked** (all `blockedBy` cleared) + has **no build job yet**, as a `kind='build'` `agent_jobs` row (`created_by=null` — the same agent-enqueue shape as `autoQueueUnblockedBy` / `queueNextChainedPhase`, so the chain/auto-ship/fold pick it up unchanged). Skips blocked specs (the reactive auto-queue handles those on their blocker's merge) and `**Auto-build:** off` opt-outs.
- **Audited + idempotent:** one `escorted_goal` [[../tables/director_activity]] row per goal it advances (`autonomous=true`, naming the goal + queued slugs); a spec that already has a build job is **confirmed in-flight**, never re-queued. **Dormant** (a no-op) until Platform is live+autonomous (Phase 4), exactly like the approval enqueuer.

## Loop-guard + CEO escalation (Phase 3 — the high-stakes calls always route UP)

The leash is hard, so a high-stakes call **always escalates to the CEO** — it is never rubber-stamped, and a failing build is never resubmitted forever. Every escalation reuses the **existing M2 inbox** (a routed Approval Request notification — the inbox API shows an item to a role iff `metadata.routed_to_function === role`), never a parallel inbox.

- **Loop-guard.** The escort tracks each escorted spec's build state (`specBuildState` — recent `agent_jobs` `kind='build'` rows for the slug: is one **active/landed** → leave it; how many **`failed`/`needs_attention`** → the failure count + latest error). On a sweep, per unblocked spec: an in-flight build ⇒ confirm, don't re-queue; **≥ `PLATFORM_DIRECTOR_LOOP_GUARD_MAX` (2) failures** with nothing in-flight ⇒ **stop + escalate** ("likely a deeper issue"), never re-queue; a single prior failure ⇒ a bounded **retry** (`instructions` note `re-attempt #2`); no builds yet ⇒ the Phase-2 gap-fill queue.
- **Re-route a declined request → CEO** (`escalateApprovalRequestToCeo`). The box lane's two escalate branches (out-of-leash / multi-choice, and the investigation `escalate`/ambiguous verdict — e.g. a **destructive** migration the runner won't auto-approve) now flip the target's routed Approval Request to `routed_to_function='ceo'` and prepend Ada's diagnosis to the body, so the **CEO** inbox shows it and Platform's no longer does. The target job stays `needs_approval` (never auto-approved); the CEO approves/declines via the normal `/api/roadmap/approve` gate. Creates a CEO-routed request if the reconciler hadn't emitted one yet (idempotent on `agent_job_id`).
- **Standalone diagnosis → CEO** (`escalateDiagnosisToCeo`). A high-stakes call with **no approvable target** — a loop-guard "deeper issue," or a **zero-progress owned goal** (only the CEO greenlights a NEW goal). Emits a CEO-routed Approval Request (no inline approve — it deep-links the CEO to the spec/goal) **and** an `escalated` [[../tables/director_activity]] row. **Deduped** on a `dedupe_key` (`loopguard:{slug}` / `newgoal:{goalSlug}`) via the `director_activity` ledger so it pings once (survives a dismissed notification). Carries **no `agent_job_id`** so [[approval-inbox]] `reconcileApprovalInbox` — which dismisses any request whose job left `needs_approval` — never reaps this standalone escalation.

## Watch the platform + report to the board (Phase 4 — the human-legible top layer)

The director's top layer is **reporting up in human terms** — and it **supervises, doesn't rebuild**: it reads the *existing* [[../dashboard/control-tower]] snapshot rather than standing up new monitoring, and reuses the *existing* board/recap/dev-ask plumbing rather than a parallel path.

- **Daily board watch** (`postPlatformWatchUpdate`). Reads [[control-tower]] `buildControlTowerSnapshot` → the **platform department rollup** (worst-of color, healthy/total, open alerts) + its red loops, plus today's [[../tables/director_activity]] (squashed = `approved_approval`, escorting = `escorted_goal`, escalated = `escalated`), and posts ONE conversational `update` as 🛠️ Ada to the [[../tables/director_messages]] board (`composePlatformWatchBody` — *"🛠️ Platform watch — all 9 platform loops green. Today: squashed 2 fixes · escorted 1 goal."*). **Idempotent** per (workspace, UTC day) on `metadata.watch_date`; skips a fully-quiet all-green day (no empty-board spam); **dormant** until live+autonomous like the escort.
- **"Answers why?"** — no new code: the [[../specs/directors-board-gamified]] Phase-2 board→dev-ask wiring ([[director-board]] `routeBoardReply`) already defaults the answer brain to Platform, so a "why?" reply under Ada's post routes to a `dev-ask` box turn that posts the answer back in-thread.
- **EOD-recap slice** — no new code: Platform is a director, so [[director-recap]] `generateDirectorRecap` already rolls its day's activity into the standup (`goalsAdvanced` ← `escorted_goal`; `bugsFixed`/`approvalsHandled` ← the director's [[../tables/approval_decisions]]) + the CEO roll-up.

**Activation (owner-confirmed).** `scripts/apply-platform-live-autonomous.ts` upserts the [[../tables/function_autonomy]] `platform` row to `live + autonomous` — the Phase-4 switch that takes every dormant surface above live (the approval router then routes platform-owned approvals to the director instead of the CEO). Idempotent + reversible (toggle off from the [[../dashboard/agents|Agents hub]]).

## Exports

- **`enqueuePlatformDirectorJobs(admin)`** → `{ enqueued, slugs }` — the poll-loop background sweep. Finds every open `needs_approval` [[../tables/agent_jobs]] routed to Platform and queues one `kind='platform-director'` job per target (instructions `{ target_job_id, target_kind }`). **Idempotent** (one director job per target, ever — the dedup that stops an infinite re-enqueue of a deferred target). No-op unless `platformIsAutoApprover`.
- **`directorLeashCandidate(job)`** → `{ actionId, category } | null` — the structural gate. Reuses [[approval-inbox]] `inlineApproveActionId` (single, plain approve/decline — not multi-choice) and adds the leash-type filter. `null` ⇒ outside the envelope ⇒ escalate.
- **`buildDirectorBrief(job, candidate)`** / **`directorInvestigationPrompt(brief)`** — the read-only Max `claude -p` investigation prompt (the cause + proposed fix inline → one JSON verdict `auto-approve｜escalate`).
- **`applyDirectorApproval(admin, target, actionId, reasoning)`** → `{ ok, error? }` — the **autonomous approve** path. Mirrors [[roadmap-actions]] `approveRoadmapAction` **without** the owner gate: marks the action `approved`, flips the job to `queued_resume` when none stay pending (**execution path unchanged**), then writes the [[../tables/approval_decisions]] row via [[approval-decisions]] `recordApprovalDecision` (`decided_by='director'`, `autonomous=true`).
- **`platformIsAutoApprover(autonomy)`** / **`routesToPlatform(kind, chart, autonomy)`** — routing predicates over [[approval-router]].
- **`escortApprovedGoals(admin)`** → `{ goals, queued, escalated }` (Phase 2 + Phase 3) — the proactive goal-escort sweep (see *Escorting goals* above). No-op until live+autonomous; queues unblocked specs of approved goals the director owns + logs `escorted_goal`, **applies the loop-guard** (escalates a repeatedly-failing build, see below), and **escalates a zero-progress owned goal** to the CEO. Driven by a throttled `scripts/builder-worker.ts` poll-loop sweep alongside `enqueuePlatformDirectorJobs`.
- **`specBuildState(admin, workspaceId, specSlug)`** → `{ inFlight, failedCount, lastError, total }` (Phase 3) — the per-spec build classification the escort + loop-guard read.
- **`escalateApprovalRequestToCeo(admin, target, diagnosis)`** → `{ ok, created }` (Phase 3) — re-route a declined Approval Request to the CEO inbox with the diagnosis (see above).
- **`escalateDiagnosisToCeo(admin, { workspaceId, specSlug, title, diagnosis, dedupeKey, deepLink, escalationKind, metadata? })`** → `{ emitted }` (Phase 3) — the deduped standalone CEO escalation (loop-guard / new goal).
- **`postPlatformWatchUpdate(admin, opts?)`** → `{ posted, reason? }` (Phase 4) — the daily board watch post (see *Watch the platform* above). Reads [[control-tower]] `buildControlTowerSnapshot` + today's [[../tables/director_activity]] and posts ONE `update` as 🛠️ Ada to [[../tables/director_messages]]. Idempotent per (workspace, UTC day) on `metadata.watch_date`; `reason` ∈ `dormant｜no_workspace｜already_posted｜quiet` when it doesn't post. No-op until live+autonomous.
- **`composePlatformWatchBody(health, activity)`** → `string` (Phase 4) — the pure persona-voice body composer (health line + activity line); types **`PlatformHealth`**, **`PlatformWatchActivity`**.
- Const **`PLATFORM`**, **`LEASH_CATEGORIES`**, **`PLATFORM_DIRECTOR_LOOP_GUARD_MAX`** (2), **`PLATFORM_DIRECTOR_RECENT_WINDOW_MS`** (7d); types **`LeashCategory`**, **`DirectorTargetJob`**, **`DirectorActionLike`**, **`DirectorBrief`**, **`GoalEscortResult`**, **`SpecBuildState`**.

## The box lane

`scripts/builder-worker.ts` `runPlatformDirectorJob` (concurrency-1 `platform-director` lane, claimed via `claim_agent_job`; `runDirectorClaude` is the Max session — read-only DB creds kept, API key stripped). It re-loads the target, **re-confirms** it still `needs_approval` and still routes to Platform (fail-safe), runs the leash gate, investigates read-only, then:
- **`auto-approve`** → `applyDirectorApproval` + a `director_activity` `approved_approval` row ([[../tables/director_activity]]).
- **`escalate`** (or any ambiguous/unparseable verdict — fail safe) → a `director_activity` `escalated` row **and** `escalateApprovalRequestToCeo` re-routes the request to the CEO inbox with the diagnosis (Phase 3). The target stays `needs_approval` (never auto-approved).

It **never** edits product code, opens a PR, or runs a migration — it only decides on the existing gated action.

**Standing pass (Phase 4).** When the job carries **no `target_job_id`** — the daily [[../inngest/platform-director-cron]] enqueue — `runPlatformDirectorJob` instead runs `runPlatformDirectorStandingPass`: `escortApprovedGoals` (Phase 2) **and** `postPlatformWatchUpdate` (the board watch) on the reliable cron beat. Best-effort (a failure in one half never blocks the other); both no-op unless live+autonomous.

## Safety invariants

- **Never rubber-stamps** — a structural leash candidate must *also* pass the investigation verdict; an ambiguous/errored result escalates, never approves.
- **The leash is hard** — destructive/irreversible, goal-touching, new-goal, and multi-choice requests always escalate (to the CEO inbox, with the diagnosis).
- **No infinite loops** — a build that fails ≥ `PLATFORM_DIRECTOR_LOOP_GUARD_MAX` (2) times is never resubmitted; the loop-guard stops and escalates a "deeper issue" diagnosis to the CEO.
- **Execution path unchanged** — the autonomous approve flips the same `queued_resume` the human path does; no action runs by a path that skips the gate.
- **Auditable** — every call (approve or escalate) logs reasoning to [[../tables/approval_decisions]] / [[../tables/director_activity]].

## Related

[[../specs/platform-director-agent]] · [[../goals/devops-director]] · [[approval-router]] · [[approval-inbox]] · [[approval-decisions]] · [[../tables/agent_jobs]] · [[../tables/approval_decisions]] · [[../tables/function_autonomy]] · [[../tables/director_activity]] · [[../operational-rules]] (§ North star)
