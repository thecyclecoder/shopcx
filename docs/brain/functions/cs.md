# CS / Customer Success (function)

The permanent owner of **customer support quality and ticket-derived product work** — the AI ticket handling, the quality analyzer + grader, escalation triage, and the **code specs that originate from real tickets**. Introduced by [[../specs/box-ticket-improve]] so the **CX manager** (the new `cs_manager` workspace role, [[../tables/workspace_members]]) has a first-class seat: she drives the ticket Improve agent, approves customer fixes, and owns the ticket-sourced specs surfaced on [[../dashboard/roadmap]].

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
- **Specs:** [[../specs/box-ticket-improve]] ⏳ · [[../specs/box-escalation-triage]] ⏳

### Escalation triage quality
Every hour, double-check the escalation queue (solver → skeptic → quorum) so mis-escalations become analyzer-fix specs and genuine issues become approved to-dos — nothing ships without agreement.
- **Specs:** [[../specs/box-escalation-triage]] ⏳

## Roles + approval

- **`cs_manager`** drives Improve + approves **customer-action** plans. **Prompt/grader-rule** approval stays at `admin` (Zach). High-blast-radius rule/code changes can require founder co-sign (flag at build).
- Shares the box-agent substrate ([[../recipes/build-box-setup]]) + the session/quorum primitive with [[../functions/platform]]'s [[../specs/box-spec-chat]].

## Owned / contributed goals

- Underpins retention by making support both faster and self-correcting; feeds [[../functions/platform]] the ticket-grounded specs that turn real customer pain into shipped code.

## Status

Charter doc (introduced by [[../specs/box-ticket-improve]]). Owns ticket quality + ticket-derived product specs.
