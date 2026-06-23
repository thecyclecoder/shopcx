# Platform/DevOps Director agent ⏳

**Owner:** [[../functions/platform]] · **Parent:** M4 — Platform/DevOps Director agent
**Blocked-by:** [[approval-routing-engine]], [[directors-board-gamified]]

The **first live director** of the [[../goals/devops-director]] goal — the agent that takes the CEO out of platform operations. A new [[../tables/agent_jobs]] `kind` (`platform-director`) that **investigates → auto-approves** its routed inbox **within the leash**, **escorts approved goals through their milestones**, **watches the platform**, and **reports up in human terms** — escalating only the genuinely high-stakes calls. It supervises the **mature tools we already have** ([[../specs/repair-agent|repair]], [[db-health-agent]], [[coverage-auto-register-agent|coverage-register]], the builder chain + auto-ship + fold, the box, [[../dashboard/control-tower]]) — it **orchestrates, it does not rebuild**. It flips Platform's M2 `live + autonomous` flag on, so the [[approval-routing-engine|routing engine]] silently re-routes platform approvals from the CEO inbox to it. Today [[../functions/platform]] owns those tools but **nothing supervises them as a director**, [[../tables/agent_jobs]] has no `platform-director` kind, and the leash in the goal is unenforced. Success metric served: **% of platform approvals the CEO never touches** (auto-handled with audited history) trending up, and **goals escorted to completion without CEO babysitting**.

## Phase 1 — the `platform-director` job kind + investigate→auto-approve (within the leash) ⏳
- ⏳ planned
- A new [[../tables/agent_jobs]] `kind='platform-director'` with its own box lane (`scripts/builder-worker.ts` `runPlatformDirectorJob`, mirroring `runCoverageRegisterJob`/the repair runner), claimed via `claim_agent_job`. Runs as a Max `claude -p` box session (read-only prod DB + brain), like dev-ask/spec-chat.
- For each Approval Request routed to **Platform** ([[approval-routing-engine]]): read the *cause + proposed fix*, confirm it is **sound + low-risk + within the leash**, then approve via the existing approve path — writing an [[../tables/approval_decisions]] row with its reasoning. **Never rubber-stamps**: a request it cannot confirm sound, or that falls outside the leash, **escalates to the CEO** (Phase 3) rather than approving.
- **The leash — auto-approves (no CEO):** error fixes · db indexes/health · **additive / reversible** migrations · **milestone progression of an already-approved goal** · platform-monitoring fixes (the [[../goals/devops-director]] § leash + the standing autonomy rule in [[../operational-rules]]).

## Phase 2 — escort approved goals through their milestones ⏳
- ⏳ planned
- The chain-driving done by hand becomes the director's job: read goal/milestone state via [[../libraries/brain-roadmap]] `getGoals()`/`specCompletion`, and drive each approved goal's unblocked specs through **self-sequence → build → merge → fold** — leaning on the existing [[../specs/spec-blockers|blocked_by auto-queue]] (`autoQueueUnblockedBy` / `reconcileMergedJobs`) and the builder chain rather than reimplementing it. As a milestone's last blocker ships, the next unblocked spec auto-queues; the director confirms each landed clean and advances the goal.
- Milestone progression of an **already-approved** goal is inside the leash (auto). **Starting a new goal is not** (Phase 3 escalation).

## Phase 3 — loop-guard + CEO escalation (the high-stakes calls) ⏳
- ⏳ planned
- **Loop-guard:** track attempts/decisions per spec (count `agent_jobs` build attempts + failures for the slug). A build that **repeatedly fails on the same error** → the director **stops**, diagnoses "likely deeper issue," and **escalates to the CEO** to approve modifying the approach — **never an infinite resubmit loop**.
- **Escalate UP to CEO** (route to the CEO inbox via M2, with the director's written diagnosis): a **repeatedly-failing build** (modify the spec/approach) · **modifying or abandoning an approved goal** · **destructive / irreversible** actions (a data-dropping migration, deleting infra) · **starting a NEW goal** (only the CEO greenlights goals). Mirrors the standing autonomy rule (autonomous for low-risk/reversible; gate high-stakes/irreversible).

## Phase 4 — watch the platform + report to the board ⏳
- ⏳ planned
- Read [[../dashboard/control-tower]] health (via its snapshot library) and post **human-readable** updates as 🛠️ Ada to the M3 board ([[directors-board-gamified]]) — what it squashed, what it's escorting, what it escalated — and contribute its slice of the **EOD recap**. Answers "why?" replies via the M3 dev-ask wiring.
- Flip Platform's [[approval-routing-engine|`live + autonomous`]] flag on as the activation switch (owner-confirmed), so platform approvals route to the director instead of the CEO.

## Safety / invariants
- **Never rubber-stamps.** Auto-approval requires the director to confirm cause + fix are sound, low-risk, and within the leash, with the reasoning logged to [[../tables/approval_decisions]] — an unconfirmable request escalates, it does not auto-approve ([[../operational-rules]] § North star).
- **The leash is hard.** Destructive/irreversible actions, modifying/abandoning a goal, a repeatedly-failing build, and starting a new goal **always** escalate to the CEO — the director can widen its own envelope only via M5 grading, never unilaterally.
- **No infinite loops.** The loop-guard stops a build that repeatedly fails on the same error and escalates a diagnosis — never blind resubmission.
- **Supervise, don't rebuild.** The director orchestrates repair / db-health / coverage-register / the builder chain / control-tower — it adds **no** parallel implementation of work those tools already do.
- **Auditable + supervisable.** Every decision (auto-approve or escalate) is logged with reasoning the CEO can read after the fact — the supervisable-autonomy contract (CEO → Director → tool).

## Completion criteria
- A `platform-director` [[../tables/agent_jobs]] kind + box lane exists; it processes Platform-routed Approval Requests, auto-approving only within the leash with logged reasoning.
- It escorts approved goals through milestones (self-sequence → build → merge → fold), reusing the blocked_by auto-queue + builder chain.
- The loop-guard stops repeated same-error builds and escalates; all high-stakes calls (destructive, goal-modify, new goal, repeatedly-failing build) escalate to the CEO.
- It posts human-readable updates + an EOD-recap slice to the M3 board and answers "why?" replies.
- Platform's `live + autonomous` flag flips on so the routing engine sends platform approvals to it; brain pages written + cross-linked from [[../goals/devops-director]].

## Verification
- Route a low-risk Platform approval (e.g. an additive migration / a db-index fix) → expect the `platform-director` job to auto-approve it within one pass, the underlying job to flip `queued_resume`, and an [[../tables/approval_decisions]] row with `decided_by='director'`, `autonomous=true`, and the director's reasoning.
- Route a **destructive** action (a data-dropping migration) → expect the director to **escalate to the CEO** (an Approval Request appears in the CEO inbox with the director's diagnosis), never auto-approve.
- Make a build fail repeatedly on the same error → expect the loop-guard to **stop** resubmitting and escalate a "likely deeper issue" diagnosis to the CEO (no infinite resubmit).
- Advance an approved goal: ship a milestone's last blocker → expect the director to confirm the next unblocked spec auto-queued and the goal advanced, with a board post describing it.
- On the M3 board, expect 🛠️ Ada/Platform posts (human-readable) + an EOD-recap slice; reply "why?" → expect a dev-ask-backed answer in-thread.
- Confirm Platform's `live + autonomous` flag is on and that new platform approvals route to the director (not the CEO inbox), appearing in CEO **Decision history**.
