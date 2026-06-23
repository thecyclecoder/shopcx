# libraries/platform-director

The queue plumbing + autonomy policy behind the **Platform/DevOps Director box worker** ([[../specs/platform-director-agent]]) — the **first live director** of the [[../goals/devops-director]] goal (🛠️ Ada). It takes the CEO out of platform operations: **investigate → auto-approve** its routed inbox (within the leash), **escort approved goals through milestones**, **loop-guard** repeated failures, and **report up in human terms** — escalating only the genuinely high-stakes calls.

**File:** `src/lib/agents/platform-director.ts`

North star (supervisable autonomy): the director is the **objective-owner** above the mature platform tools ([[../specs/repair-agent|repair]], [[../specs/db-health-agent|db-health]], [[coverage-register-agent|coverage-register]], the builder chain, [[control-tower]]). It **orchestrates, it does not rebuild** — it leans on the existing [[agent-jobs]] approve path + the `blocked_by` auto-queue (`autoQueueUnblockedBy`) rather than reimplementing them. Every decision is logged to [[approval-decisions]] + [[director-activity]] so the CEO can audit what the proxy decided and why.

**Activation** is the [[approval-router|`live + autonomous`]] flag on the `platform` function ([[../tables/function_autonomy]]) — **off by default** (owner-confirmed via the autonomy API/Agents hub). The director lane only fires when `platform` is an auto-approver, and the [[approval-inbox|routing engine]] then sends platform approvals to it instead of the CEO. Fail-safe to the bone — an unconfirmable request, or any high-stakes call, **escalates**; it never auto-approves on uncertainty.

## The runner (box lane)

`scripts/builder-worker.ts` `runPlatformDirectorJob` — a `kind='platform-director'` [[agent-jobs]] lane (concurrency-1, re-runnable), claimed via `claim_agent_job`, running a Max `claude -p` investigation (`runPlatformDirectorClaude` — keeps read-only prod creds, strips the API key). Enqueued by the poll loop's `enqueuePlatformDirectorTick` when `platform` is live+autonomous and there's routed work (or the escort cadence is due). One **tick** = one director "shift": process inbox → escort goals → loop-guard → board post.

## The leash (autonomy policy)

- **Auto-approves (no CEO):** error fixes · db indexes/health · **additive / reversible** migrations · **milestone progression of an already-approved goal** · platform-monitoring fixes.
- **Escalates UP to CEO:** a **repeatedly-failing build** (deeper issue) · **modifying / abandoning** an approved goal · **destructive / irreversible** actions · **starting a NEW goal** · OR any request it cannot confirm sound.

`isDestructiveApproval` + `leashClass` are the **hard guard** (destructive/new-goal escalate without consulting the LLM); the Max investigation is the **confirm step** for everything else (never rubber-stamps).

## Exports

- Constants: `PLATFORM_DIRECTOR_FUNCTION` (`"platform"`) · `PLATFORM_DIRECTOR_SLUG` (tick sentinel) · `PLATFORM_LOOP_GUARD_MAX` (2) · `PLATFORM_RECENT_WINDOW_MS` (7d) · `PLATFORM_ESCORT_CADENCE_MS` (30m).
- `type RoutedApproval` · `type ApprovalVerdict` · `type LeashClass = "auto-eligible" | "escalate" | "judge"`.
- `isDestructiveApproval(a)` / `leashClass(a)` — **pure** leash pre-classification (destructive/irreversible always escalates).
- `getRoutedPlatformApprovals(admin, workspaceId)` — the director's inbox: join each undismissed `agent_approval_request` notification routed to `platform` to its still-`needs_approval` [[agent-jobs]] row.
- `buildFailureCount(admin, specSlug)` — the loop-guard ledger (failed `build` jobs for a slug within the window). `alreadyEscalated(admin, ws, slug)` — escalation dedup.
- `enqueuePlatformDirectorTick(admin)` — autonomy-gated, deduped, work-or-cadence enqueue of one tick. Never throws.
- `directorApproveApproval(admin, { workspaceId, approval, reasoning })` — the existing approve path (mark pending actions approved → `queued_resume`) + log to [[approval-decisions]] + [[director-activity]].
- `directorEscalateApproval(admin, { workspaceId, approval, diagnosis })` — re-route the inbox request to the CEO (set `routed_to_function='ceo'` + append the diagnosis) + log the escalation.
- `platformDirectorBrief(approvals)` / `platformDirectorPrompt(brief)` — the read-only Max investigation (confirm sound + within-leash; emit per-approval verdicts + a board line).

## Related

[[approval-router]] · [[approval-inbox]] · [[approval-decisions]] · [[director-activity]] · [[director-board]] · [[brain-roadmap]] · [[agent-jobs]] · [[control-tower]] · [[../tables/approval_decisions]] · [[../tables/function_autonomy]] · [[../specs/platform-director-agent]] · [[../specs/approval-routing-engine]] · [[../specs/directors-board-gamified]] · [[../goals/devops-director]]
