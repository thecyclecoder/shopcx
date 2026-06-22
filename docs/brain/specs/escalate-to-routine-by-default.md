# Escalate to the AI Routine by Default ✅

**Owner:** [[../functions/cs]] · **Parent:** completes [[box-escalation-triage]] — the hourly triage cron has been live but **idle**, because nothing is ever escalated *to the routine*.

**The gap.** `triage-escalations-cron` ([[../inngest/triage-escalations]]) triages tickets that are **`escalated_at` set + `escalated_to IS NULL`** (its definition of "routine-owned"). But `escalated_to` is `UUID REFERENCES auth.users(id)`, and **every escalation path round-robins to a human** (`escalated_to = assignee`), so that NULL state is never produced and the cron finds 0 work. Observed: an escalated "Cancel order" ticket sat 3h, the cron enqueued **0** jobs ever, `triage_runs` empty — because the ticket was escalated *to the owner*, not the routine. There's also **no "AI Routine" option in the escalate UI**, so a human can't route to it either.

**The model (no schema change).** "Escalated to the AI Routine" = **`escalated_at` set + `escalated_to = NULL`** (the cron's existing signal; NULL is the only non-human value the FK allows). A non-null `escalated_to` = escalated to that human. Make the system *produce* the routine state by default + make it selectable + legible.

## Fix
1. **Code escalations default to the routine.** Where the system escalates — `src/lib/ticket-analyzer.ts` (~792), `src/lib/action-executor.ts` (~2667), `src/lib/workflow-executor.ts` (~385), `src/lib/portal/remediation.ts` (~312) — stop round-robining to a human: set **`escalated_to = null`** (keep `escalated_at` + `escalation_reason`, and don't pre-assign `assigned_to` to a person). AI/workflow/orchestrator/portal escalations now land in the routine's lap → the cron picks them up next tick → solver→skeptic→quorum → approval-gated todos.
2. **UI: "🤖 AI Routine" is a first-class, default escalate target.** In the ticket escalate control (`src/app/dashboard/tickets/[id]/page.tsx` + list), add "AI Routine" at the top of the escalate-to dropdown (the default); selecting it sets `escalated_to = null` + `escalated_at`. Render **"AI Routine"** (not blank) wherever an escalated ticket shows its target (`page.tsx` ~839, `[id]/page.tsx` ~2632, `/dashboard/tickets/escalated`).
3. **Human handoff preserved.** A user can still escalate to a specific person (sets `escalated_to = their uuid` → human-owned, cron skips). The routine's **no-quorum** path escalates *up* to a human (sets a real `escalated_to`) — so unresolved cases still reach a person.
4. **Cron unchanged** — already matches `escalated_at` set + `escalated_to IS NULL`.

## Verification
- Trigger an AI/workflow escalation (low-quality score, or an `escalate` action) → the ticket has `escalated_at` set + **`escalated_to = NULL`**; within the hour `triage-escalations-cron` (:30) enqueues a `triage-escalations` job (or sooner if manually kicked), the box triages it, and pending todos appear for approval. `triage_runs` gets a row.
- On `/dashboard/tickets/{id}`, the escalate dropdown shows **"🤖 AI Routine"** at top (default); selecting it routes to the routine (escalated_to null), and the ticket header renders "Escalated to: AI Routine".
- Escalate to a **specific human** → `escalated_to = their uuid`, the cron skips it (human owns it), header shows that person.
- Negative: a routine escalation does **not** pre-assign a human (`assigned_to` not set to a person); a no-quorum triage outcome escalates up to a real human (`escalated_to` set).

## Phase 1 — route to routine + UI option ✅
The four code-path changes (escalated_to → null) + the escalate-UI "AI Routine" option & display + no-quorum human handoff. Brain: [[box-escalation-triage]] · [[../inngest/triage-escalations]] · [[../libraries/ticket-analyzer]] · [[../dashboard/tickets]] (escalate control). Fold on ship.

### What shipped
- **Code escalations default to the routine** — `escalated_to = null` (keep `escalated_at` + `escalation_reason`, no `assigned_to` pre-assign): `src/lib/ticket-analyzer.ts` (low-score re-open, dropped the round-robin), `src/lib/action-executor.ts` `escalateTicket` (orchestrator `escalate` action, dropped the round-robin + `assigned_to`), `src/lib/workflow-executor.ts` `escalate` (now always sets `escalated_at`/reason; `escalated_to = assignTo` which is null = routine), `src/lib/portal/remediation.ts` `escalate` (dropped the owner lookup; guard + fetch now key on `escalated_at` so a routine-escalated ticket isn't re-processed by the healer cron).
- **UI option + display** — `src/app/dashboard/tickets/[id]/page.tsx`: "🤖 AI Routine" is the top option of the "Escalated To" dropdown; selecting it PATCHes `{ escalate_to_routine: true }`. New flag handled in `src/app/api/tickets/[id]/route.ts` (sets `escalated_at` + `escalated_to = null`, distinct from "" = de-escalate). Header renders "Escalated … to AI Routine" when `escalated_at` set + `escalated_to` null. List page (`tickets/page.tsx`) shows the escalate icon (title "Escalated to AI Routine") for routine escalations; `escalated=true` filter in `/api/tickets` keys on `escalated_at`. `/dashboard/tickets/escalated` "routine" badge relabeled "🤖 AI Routine".
- **No-quorum human handoff** — `handUpExhaustedTriage` (`src/lib/agent-todos/triage.ts`), called at the start of `runEscalationTriageJob` (`scripts/builder-worker.ts`): a routine ticket that hit 3 no-quorum runs without materializing is escalated up to a real human (`escalated_to` = workspace owner), leaving the routine pool. Cron + `selectEscalatedForTriage` unchanged.

> **Display since superseded** — the plain "AI Routine" wording for the `escalated_to IS NULL` state is now the prominent **"🔍 Escalated → AI Investigation"** badge (amber) across the ticket header/list/escalated view, reading as *active investigation* not just a queue. The escalate-to-routine dropdown option stays "🤖 AI Routine". See [[ai-investigation-ticket-visibility]].

### Verification (built)
- On `/dashboard/tickets/{id}`, open the **Escalated To** dropdown → expect "🤖 AI Routine" at the top; select it → expect the ticket header to read "Escalated … to AI Routine", `escalated_at` set, `escalated_to` null in the DB.
- Pick a **specific person** in the same dropdown → expect `escalated_to = their uuid`, the routine cron (`escalated_to IS NULL`) skips it, header shows that person.
- Pick **Not escalated** → expect `escalated_at` + `escalated_to` both null.
- Trigger a low-score auto-analysis / an orchestrator `escalate` / a workflow delivery-failure / a portal-action failure with no human → expect `escalated_at` set + `escalated_to` null + no `assigned_to`; within the hour `triage-escalations-cron` enqueues a job and a `triage_runs` row appears.
- On `/dashboard/tickets/escalated`, a routine-escalated ticket → expect the "🤖 AI Routine" badge; after 3 no-quorum sweeps → expect `escalated_to` set to the workspace owner and the badge flips off "routine".
