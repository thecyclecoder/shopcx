# Workflow actions own final ticket status — orchestrator must not reopen ✅

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `a89dcf76-f24c-4263-ad42-0ad027401ff5`

executeSonnetDecision should return a new statusManaged:true flag from its 'workflow' case (action-executor.ts:2015-2017), and the post-execute status block in unified-ticket-handler.ts (1717-1755) should add a branch — after escalated, before the messageSent check — that, when statusManaged is true, leaves the ticket status untouched because the workflow executor already set the authoritative status in sendReply (workflow-executor.ts:366-373: closed for account_login, open for return_to_sender at :595). Do NOT simply copy the journey patch (action-executor.ts:2008 sets messageSent=true), because that routes through setStatus (unified-ticket-handler.ts:434) which always forces status='closed' and would wrongly close intentionally-open workflows. Add a regression check that an account_login run ends with the ticket closed and a return_to_sender run ends with it open. Update docs/brain/lifecycles for ticket handling and the action-executor/workflow-executor library pages.

## Problem (from ticket `a89dcf76-f24c-4263-ad42-0ad027401ff5`)
Ticket a89dcf76 (Mindy Freeman, chat): account_login workflow sent the magic-link message and closed the ticket, but the orchestrator's post-execute logic immediately reopened it with 'No customer message sent — ticket kept open for agent review,' because the 'workflow' action type never reports that the workflow sent a message / set a status. Founder rule: sending a magic link should leave the ticket closed.

## Phases
- ✅ **P1 — implement the fix** — `executeSonnetDecision` now returns `statusManaged` (true from the `workflow` case via `handleWorkflow`); the post-execute block in `unified-ticket-handler.ts` (via the new pure `postExecuteStatusAction` helper) leaves a status-managed ticket untouched, after the escalated branch and before the closed/messageSent checks. Regression check added; brain pages updated. `npx tsc --noEmit` green.

## What landed
- `src/lib/action-executor.ts` — `executeSonnetDecision` return type gains `statusManaged: boolean`; the `workflow` case sets it from `handleWorkflow`, which now returns `true` only when a workflow actually ran (false on missing-handler / workflow-not-found, which escalates).
- `src/lib/inngest/unified-ticket-handler.ts` — new exported pure helper `postExecuteStatusAction(execResult, agentAssigned)` encodes the branch order (`escalated` → `status_managed` → `closed` → `message_sent` → no-action); the post-execute block switches on it. The `status_managed` branch leaves the workflow-set status as-is (no `setStatus`).
- `scripts/_regress-workflow-status-authoritative.ts` — pure-logic regression: asserts `account_login` ends closed, `return_to_sender` ends open, the pre-fix path reproduces the reopen bug, and escalation still wins.
- Brain: `lifecycles/ticket-lifecycle.md` (Phase 5 + workflow bullet), `libraries/action-executor.md`, `libraries/workflow-executor.md`.

## Verification
- Run `npx tsx scripts/_regress-workflow-status-authoritative.ts` → expect all ✅ and final `PASS` (exit 0).
- In prod, send an `account_login` request (e.g. "I can't log in") on a chat/email ticket → expect the magic-link reply sent AND the ticket ends `status='closed'` with `closed_at` set, with a `[System] Workflow set the ticket status directly — leaving it as-is.` note (no "No customer message sent" reopen note).
- Trigger a `return_to_sender` order-tracking workflow → expect the replacement reply sent AND the ticket ends `status='open'` (not auto-closed).
- Re-check ticket `a89dcf76` (Mindy Freeman): the same scenario would now end closed, not reopened.

> Authored by the box Improve agent from ticket `a89dcf76-f24c-4263-ad42-0ad027401ff5`. Commission the build from the Roadmap board (owner = cs).
