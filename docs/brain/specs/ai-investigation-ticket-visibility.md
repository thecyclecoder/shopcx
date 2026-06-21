# "AI Investigation" — make routine-escalated tickets visible ⏳

**Owner:** [[../functions/cs]] · **Parent:** refines [[escalate-to-routine-by-default]] + [[box-escalation-triage]]. Found in use 2026-06-21: a ticket routed to the routine (`escalated_to=null`) gives a human agent **no visual signal** that it's escalated or that triage is working it — so they can't tell to wait/coordinate vs. step in.

When a ticket is **escalated to the routine** (`escalated_at` set + `escalated_to IS NULL`), make it obviously flagged — call it **"AI Investigation"** — and leave a paper trail in the thread so a human agent knows the AI is taking a stab and can still intervene.

## What to add
1. **Prominent ticket badge/banner.** On `/dashboard/tickets/{id}` (header) **and** the ticket list + the Escalated view, a routine-escalated ticket shows a clear **"🔍 Escalated → AI Investigation"** badge (amber/escalation styling), not blank. If a `triage-escalations` job is currently in-flight for its workspace, append **"· triage in progress"**. (This is the visible label for the `escalated_to IS NULL` state — supersedes the plainer "AI Routine" wording so it reads as *active investigation*, not just a queue.)
2. **Internal note when triage takes a stab.** In the triage runtime (`runEscalationTriageJob` / [[box-escalation-triage]]), when the routine **starts** working an escalated ticket, post an **internal note**: `[AI Investigation] Looking into this escalated ticket (solver → skeptic → quorum)…`. On outcome, a follow-up internal note: **proposed N todos for approval** / **no quorum — left escalated for a human** / **mis-escalation — un-escalated**. So the timeline shows what the AI did, and a human reading the ticket sees it's handled (or needs them).
3. **Human can still intervene.** The badge informs, it doesn't lock — an agent can pick the ticket up (escalate to themselves / reply) at any time; doing so (setting a human `escalated_to` or assigning) flips it out of AI-Investigation state.

## Verification
- Open a routine-escalated ticket (`escalated_at` set, `escalated_to=null`) → the header shows **"🔍 Escalated → AI Investigation"**; with an in-flight triage job it reads "· triage in progress". Same badge on the list + Escalated view.
- After the triage job runs → the ticket thread has an internal **`[AI Investigation]`** note describing what it did (proposed todos / no-quorum / mis-escalation). The note is internal-only (not customer-visible).
- A human escalating the ticket to a person (or assigning themselves) → the badge changes from "AI Investigation" to that person; the ticket leaves the routine's queue.
- Negative: a non-escalated ticket shows no AI-Investigation badge; the internal note is never customer-facing.

## Phase 1 — badge + triage internal notes ⏳
The "AI Investigation" badge on ticket header/list/escalated view for `escalated_to IS NULL` + `escalated_at` (with "triage in progress" when a job is live); the `[AI Investigation]` start + outcome internal notes in `runEscalationTriageJob`. Brain: [[../dashboard/tickets]] · [[box-escalation-triage]] · [[escalate-to-routine-by-default]]. **Queue after [[escalate-to-routine-by-default]] merges** (shared ticket-UI files). Fold on ship.
