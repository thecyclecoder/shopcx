# Workflow actions own final ticket status — orchestrator must not reopen ⏳

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `a89dcf76-f24c-4263-ad42-0ad027401ff5`

executeSonnetDecision should return a new statusManaged:true flag from its 'workflow' case (action-executor.ts:2015-2017), and the post-execute status block in unified-ticket-handler.ts (1717-1755) should add a branch — after escalated, before the messageSent check — that, when statusManaged is true, leaves the ticket status untouched because the workflow executor already set the authoritative status in sendReply (workflow-executor.ts:366-373: closed for account_login, open for return_to_sender at :595). Do NOT simply copy the journey patch (action-executor.ts:2008 sets messageSent=true), because that routes through setStatus (unified-ticket-handler.ts:434) which always forces status='closed' and would wrongly close intentionally-open workflows. Add a regression check that an account_login run ends with the ticket closed and a return_to_sender run ends with it open. Update docs/brain/lifecycles for ticket handling and the action-executor/workflow-executor library pages.

## Problem (from ticket `a89dcf76-f24c-4263-ad42-0ad027401ff5`)
Ticket a89dcf76 (Mindy Freeman, chat): account_login workflow sent the magic-link message and closed the ticket, but the orchestrator's post-execute logic immediately reopened it with 'No customer message sent — ticket kept open for agent review,' because the 'workflow' action type never reports that the workflow sent a message / set a status. Founder rule: sending a magic link should leave the ticket closed.

## Phases
- ⏳ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the ticket scenario → confirm the fixed behavior, and that the ticket that surfaced it would now be handled correctly.

> Authored by the box Improve agent from ticket `a89dcf76-f24c-4263-ad42-0ad027401ff5`. Commission the build from the Roadmap board (owner = cs).
