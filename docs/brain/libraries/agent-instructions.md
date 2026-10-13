# libraries/agent-instructions

The per-worker **instruction store** library — the runtime load + the **director-gated coach write path** ([[../specs/worker-coaching-loop]], Phase 1). Reads/writes [[../tables/agent_instructions]] + [[../tables/agent_coaching_log]]. This is the data layer that makes **coaching a data write, not a deploy**.

**File:** `src/lib/agents/agent-instructions.ts` (server-only — service-role admin client).

## The runtime load (every worker run)

- **`loadAgentInstructions(admin, workspaceId, agentKind): Promise<AgentInstruction[]>`** — a worker's `status='active'` guidance, newest-first. Best-effort: `[]` if the table is absent (a runtime caller never crashes on a missing migration).
- **`formatAgentInstructions(instructions): string`** — render the active guidance as a prompt block ("## Coaching guidance … obey these") or `""` when there are none.
- **`appendAgentInstructions(admin, workspaceId, agentKind, basePrompt): Promise<string>`** — the **one helper a worker run calls**: load → format → append to the base prompt (unchanged when there's no guidance). Wired into `scripts/builder-worker.ts` `runRepairJob` + `runRegressionJob` (the LLM workers) right before the `claude -p` call.

## The director-gated coach write path

- **`coachAgent(admin, input): Promise<{ instruction, coaching, attempt }>`** — amend a worker's instruction set: insert a new **active** [[../tables/agent_instructions]] row (superseding any prior active row for the same `error_class`, bumping `version`), retire the prior, and log the director→worker message to [[../tables/agent_coaching_log]] (the old→new diff, the triggering pattern, the source activity ids, the attempt count). **Director-gated:** `input.coachedBy` (the supervising director's slug) is **required** — throws without it. `input = { workspaceId, agentKind, coachedBy, errorClass, guidance, triggeringPattern, reasoning, sourceActivityIds?, sourceGradeId? }`. Throws on a write error (the caller decides recovery). The board post + [[director_activity]] write are done by the **caller** ([[worker-coaching]] `runAgentCoachingPass`), keeping this a pure data write any host can reuse.
  - ⭐ **security-review-lane-must-always-produce-a-verdict Phase 3 guardrail.** `coachAgent` REFUSES (throws) to persist coaching for `agentKind === 'security-review'` whose guidance would add an EARLY EXIT — the RC2 class: a specs-row preflight that bails before reviewing, or a "fall straight to needs-human" / no-op shortcut. The security-review lane must ALWAYS review the diff and produce a real verdict (clean/false-positive/real-vuln); no coaching may short-circuit that. The pure, exported predicate `coachingWouldAddSecurityEarlyExit(guidance)` is the gate (a legitimate "review X more carefully" note is unaffected). Pinned by `src/lib/agents/agent-instructions.security-guardrail.test.ts`. The five pre-existing active security-review coaching rows are retired by migration `20270108120000_supersede_security_review_early_exit_coaching.sql`.
- **`coachingWouldAddSecurityEarlyExit(guidance): boolean`** — pure guardrail predicate (above); true iff the guidance adds a security-review early-exit/no-op shortcut.
- **`linkCoachingBoardPost(admin, coachingId, boardMessageId)`** — stamp the #directors board post id onto the coaching row after the caller posts it.
- **`revertCoaching(admin, instructionId)`** — flip an amendment to `status='reverted'` (it stops being loaded). Coaching is reversible by design.
- **`recordRecheck(admin, coachingId, 'stuck'|'recurred')`** — write the post-coaching re-check verdict.

## Reads for the surfaces

- **`getAgentCoachingHistory(admin, workspaceId, agentKind, limit=50): Promise<AgentCoachingEntry[]>`** — a worker's coaching history newest-first. Backs `GET /api/developer/agents/coaching?kind=…` → the profile page's "Coaching history" section.

## Types

- **`AgentInstruction`** — a camelCased [[../tables/agent_instructions]] row.
- **`AgentCoachingEntry`** — a camelCased [[../tables/agent_coaching_log]] row.

## Why this exists

The worker NEVER edits its own instructions — only its director coaches it (north-star CEO → director → worker). Enforced two ways: `coachAgent` requires a `coachedBy` director slug, and the tables are **service-role-write-only**. See [[../operational-rules]] § North star.

## Related

[[../tables/agent_instructions]] · [[../tables/agent_coaching_log]] · [[worker-coaching]] · [[director-activity]] · [[director-board]] · [[../specs/worker-coaching-loop]] · [[../goals/devops-director]]
