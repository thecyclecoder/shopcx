# CS / Customer Success (function)

The permanent owner of **customer support quality and ticket-derived product work** — the AI ticket handling, the quality analyzer + grader, escalation triage, and the **code specs that originate from real tickets**. Introduced by [[../specs/box-ticket-improve]] so the **CX manager** (the new `cs_manager` workspace role, [[../tables/workspace_members]]) has a first-class seat: she drives the ticket Improve agent, approves customer fixes, and owns the ticket-sourced specs surfaced on [[../dashboard/roadmap]].

> **Operate + author, never build (CEO directive 2026-06-29).** The CS director OPERATES its own software (its `function_autonomy` is *operational* autonomy) and AUTHORS specs for the tools it needs — it is the requester/operator. It NEVER drives a build: **Ada / Platform / DevOps is the sole builder for every spec, all departments, permanently** ([[platform]]). A CS-owned spec's `owner` is attribution + where the finished tool's operation lives; the build is always Ada's. CS going live+autonomous does not move build-driving onto it.

## Scope + owned metrics

- **Owns:** the ticket Improve agent ([[../specs/box-ticket-improve]]), escalation triage ([[../specs/box-escalation-triage]]), the AI quality analyzer + grader rules ([[../lifecycles/ai-analysis]]), the conversation-rule library proposers ([[../tables/sonnet_prompts]] + `grader_prompts`), and **ticket-derived code specs** (`owner = cs`, `Derived-from-ticket:` ref).
- **North-star metrics:** ticket quality score trend, escalation rate + correct-escalation rate, time-to-resolve on weird tickets, repeat-issue rate (did the rule/spec actually stop recurrence).

## Mandates (perpetual)

### Fix weird tickets fast, calibrate so they don't recur
Reproduce the founder's terminal "fix this ticket" chat inside the Improve tab — on Max, approval-gated — so the founder *and* the CX manager can investigate, act, and calibrate in one place.
- **Metric:** weird-ticket resolution time ↓, repeat-issue rate ↓, human-touch per fix ↓.
- **Specs:** [[../specs/box-ticket-improve]] ⏳

### Ticket-derived product fixes
A code recommendation from a ticket becomes a **ticket-sourced spec** (owner = cs, `Derived-from-ticket:` ref) committed to main and surfaced on [[../dashboard/roadmap]] — the founder/CX manager commissions the build (the existing `kind='build'` flow). The Improve agent + escalation triage **never build code themselves**; they hand Roadmap a well-formed, ticket-grounded spec.
- **Metric:** ticket→spec→shipped-fix cycle time; share of recurring issues closed by a structural fix vs. one-off remediation.
- **Specs:** [[../specs/box-ticket-improve]] ⏳ · [[../specs/box-escalation-triage]] ✅

### Escalation triage quality
CS owns the **hourly box-hosted solver → skeptic → quorum sweep** of the escalation queue ([[../specs/box-escalation-triage]], shipped): each escalated ticket is adversarially double-checked before anything materializes, so genuine issues become approved `agent_todos` ([[../tables/agent_todos]]), recurring rule gaps become admin-approvable proposed `sonnet_prompts`, **mis-escalations become analyzer-fix specs** (owner=cs, `Derived-from-ticket:`, targeting `src/lib/ticket-analyzer.ts`) commissioned on [[../dashboard/roadmap]], and **no-quorum disagreements leave the ticket escalated for a human**. Every run is audited in [[../tables/triage_runs]]. Nothing ships without solver + skeptic agreement.
- **Specs:** [[../specs/box-escalation-triage]] ✅

## Roles + approval

- **CS Director agent** ([[../libraries/cs-director]] — persona 💬 **June**) — supervises the ticket-improve loop + the escalation-triage quorum, sits above the quorum as the **third rung of the escalation ladder** (orchestrator → triage quorum → CS Director → founder), auto-approves within the CS leash and escalates the rest to the CEO. Identity + placement scaffolded by [[../specs/cs-director-persona-and-org-placement]]; **now live** — the [[../goals/guaranteed-ticket-handling|guaranteed-ticket-handling]] goal's M5 shipped the hard-call path ([[../specs/cs-director-third-rung-hard-calls-above-triage-quorum]]), the founder [[../tables/cs_director_digests|storyline digests]] with bidirectional reply ([[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]]), and the CEO's anti-Goodhart grader that NEVER rewards "fewest escalations to Dylan" ([[../specs/cs-director-grade-with-antigoodhart-rubric-no-fewest-escalations]]). Operates + authors, never builds (Ada builds — see the CEO directive above).
- **June's team (agent_jobs kinds under CS)** — the workers June supervises, each a persona in the org cast: **🧭 Sol** (`ticket-handle`, Ticket Handler) sets the ticket's direction at first-touch + every inflection (post-drift, post-frustration) via [[../libraries/ticket-directions]] (`writeDirection` / `superseDirection` / `getLiveDirection`, backing the [[../tables/ticket_directions]] one-live-row artifact per [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]]) — internal identity, customers still see the Suzie/Julie signatures; **📊 Cora** (`ticket-analyze`, Ticket Analyzer) grades every AI-handled ticket + decides reopen/escalate; **📝 Wren** (`prompt-review`, Prompt Analyzer) reviews every proposed `sonnet_prompt`. Converting the analyzer + prompt-reviewer off raw AI-API crons onto supervised box sessions: [[../specs/ticket-analyzer-becomes-box-agent-under-june]] · [[../specs/prompt-auto-review-becomes-box-agent-under-june]].
- **`cs_manager`** drives Improve + approves **customer-action** plans. **Prompt/grader-rule** approval stays at `admin` (Zach). High-blast-radius rule/code changes can require founder co-sign (flag at build).
- Shares the box-agent substrate ([[../recipes/build-box-setup]]) + the session/quorum primitive with [[../functions/platform]]'s [[../specs/box-spec-chat]].

## Owned / contributed goals

- **[[../goals/guaranteed-ticket-handling|Ticket handling — guaranteed, observable, self-running]]** (owned) — **shipped + folded 2026-07-07.** All five milestones landed atomically: M1 truthful actions (verify-in-DB coverage + refund integrity via the [[../tables/order_refunds]] mirror), M2 the resolution record (the [[../tables/ticket_resolution_events]] write-ahead ledger + confidence-gated clarify), M3 right-cost routing (model-picker on typed state, the [[../tables/action_handler_aliases]] catalog, `skip_next_order` retired), M4 the capability + [[../inngest/playbook-compiler|compiler loop]], and M5 the autonomous CS Director (💬 June). The end-to-end trace lives on [[../lifecycles/ticket-lifecycle]] § Guaranteed ticket handling. This is the goal that took CS from tag-string control + free-written claims to typed-state routing + verified actions + a supervised director on top.
- Underpins retention by making support both faster and self-correcting; feeds [[../functions/platform]] the ticket-grounded specs that turn real customer pain into shipped code.

## Status

Charter doc (introduced by [[../specs/box-ticket-improve]]). Owns ticket quality + ticket-derived product specs.
