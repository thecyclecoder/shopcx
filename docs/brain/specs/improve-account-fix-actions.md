# Improve Agent — Account-Fix Actions (reassign · magic link · link dupes) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[box-ticket-improve]] (the box Improve agent's action surface) + [[../functions/cs]]. Same approval-gate model — the box **proposes**, the founder/CX manager **approves**, the Improve route **executes** server-side.

Add the customer-account-repair actions the Improve agent was **missing** (surfaced live 2026-06-20 by Mindy Freeman's login ticket `a89dcf76`): the box correctly *diagnosed* a typo'd-duplicate-account mess but couldn't *fix* it — it had no action to re-point the ticket to the right customer or to (re)send a magic login link, so a human had to do both by hand. This gives the box those abilities, gated.

**Outcome:** when the box finds a ticket on the wrong/duplicate customer record or a login link that went to the wrong address, it can **propose** the fix (re-point + fresh magic link, optionally link the duplicate) → one approval → done, instead of "here's what's wrong, now you go do it."

## The triggering case (what was missing)
Mindy had two records: `mindyfeeman7@gmail.com` (no 'r', empty shell, Shopify 8720677404845) and `mindyfreeman7@gmail.com` (real, 22 orders / 2 subs). The ticket was attached to the shell, so the account_login workflow minted a magic link for the empty account **and** emailed it to the misspelled address. The box diagnosed this perfectly but its action set (`partial_refund｜create_return｜…｜send_message｜propose_sonnet_prompt｜propose_grader_rule`) has **no** "fix the account linkage / resend the link" — so re-pointing the ticket + resending the corrected link were done manually.

## New actions (proposable by the box, approval-gated, executed server-side)
All land in the typed plan (`pending_plan.actions`), render on the approval card, and execute via the Improve route (`runImproveActions`/`action-executor.ts`) — never by the secret-stripped box session.
- **`reassign_ticket_customer`** `{ ticket_id, to_customer_id, reason }` — re-point `tickets.customer_id` to the correct customer (the typo/duplicate case). Records an internal note with the from→to + reason.
- **`send_magic_link`** `{ ticket_id }` — generate a portal login link **for the ticket's current customer** via `generateMagicLinkURL(customerId, shopifyCustomerId, email, workspaceId)` ([[../libraries/magic-link]]) and send it as an external reply to that customer's email (reuse the `send_message`/`sendTicketReply` path + the standard login-link template). Always uses the **current** ticket customer — so pairing it *after* `reassign_ticket_customer` in one plan sends the right link to the right inbox.
- **`link_customer_accounts`** `{ primary_customer_id, duplicate_customer_id, reason }` (stretch) — link/merge a duplicate **empty shell** into the real account so future tickets + magic links resolve correctly (the root cause, not just this ticket). Conservative: only when one side is a clear empty shell (0 orders/subs/points); otherwise propose-for-review only.

## Guardrails (supervisable autonomy)
- **Investigation stays free/read-only; these mutations are approval-gated** (same as every Improve customer action). The box never silently reassigns a ticket, emails a login link, or merges accounts.
- **`send_magic_link`** is security-sensitive (it's account access) — it always targets the ticket's on-file customer email (no free-text recipient), and only after any reassignment in the same approved plan, so a link can't be sent to an arbitrary address.
- **`link_customer_accounts`** is the highest blast-radius — gate it to founder approval (not `cs_manager`-alone) and require the empty-shell heuristic; never merge two non-empty accounts automatically.

## Also: have the analyzer catch this pattern
The duplicate/typo'd-email "empty shell gets the magic link" failure is recurring and self-detectable. Add it to the escalation-triage solver's playbook (and/or a grader signal): a login ticket whose on-file email has a near-duplicate account with the real order history → propose `reassign_ticket_customer` + `send_magic_link` (+ `link_customer_accounts`). (Ties into [[box-escalation-triage]].)

## Data model
No new tables. New `pending_plan.actions[].type` values + their executors in `action-executor.ts`/`improve-actions.ts`; surfaced on the Improve approval card; documented in [[../orchestrator-tools]]. `tickets.customer_id` update + `customers` link are existing columns.

## Verification
- On a ticket attached to a typo'd/empty duplicate, in the Improve tab ask the box to fix the login → it proposes `reassign_ticket_customer` (→ real account) + `send_magic_link` in one plan. Approve → ticket re-points, a fresh link for the real account emails to the real address, internal notes record it. (Reproduces the Mindy `a89dcf76` fix, now one-tap.)
- On a correctly-attached ticket, propose+approve `send_magic_link` alone → emails a valid 24h link to the on-file address; the token decodes to that customer.
- On the Improve approval card, approve a plan containing `link_customer_accounts` **as a non-owner** (cs_manager/admin) → `POST /api/tickets/[id]/improve` (action:execute) returns **403** ("founder-gated — only the workspace owner can approve"); nothing merges. Approve the same plan **as the owner** → the executor links the duplicate (when it's a true empty shell) and posts the `[Admin Improve] Linked duplicate empty-shell account …` internal note.
- Propose `link_customer_accounts` where `duplicate_customer_id` has real history (orders/subs/points) → the executor **refuses** with `link_customer_accounts: refused — duplicate … is NOT an empty shell (N orders, …)`; no `customer_links` row is written. Two real accounts are never auto-merged.
- In `customer_links`, confirm the duplicate joins the real account's `group_id` as `is_primary=false` (primary `is_primary=true`); re-running the same link is idempotent (`already linked`).
- Escalation-triage: a login ticket on a typo'd empty shell with a near-duplicate real-history email is swept → the solver emits a `customer_fix` proposing `reassign_ticket_customer` → `send_magic_link` (+ `link_customer_accounts`); on quorum the worker materializes `pending` `agent_todos`. Approve them (owner/admin) → `agent-todos/execute.ts` dispatches via `runImproveOnlyAccountAction` (not "Unknown action type"), the empty-shell rail still applies, and the ticket unescalates/closes on the last todo.

## Phases
- ✅ **P1:** `reassign_ticket_customer` + `send_magic_link` (executor + skill + approval-card + orchestrator-tool docs). Executors are bespoke `customer_action` cases in [[../libraries/improve-actions]] (Improve-only; no Sonnet-runtime equivalent), routed through `runImproveActions`; the approval card renders them generically by `kind`+`label`. `send_magic_link` reuses `generateMagicLinkURL` + the `sendTicketReply` path and always targets the ticket's current on-file customer email. Shipped 2026-06-20.
- ✅ **P2:** `link_customer_accounts` (empty-shell heuristic, founder-gated) + the escalation-triage solver's detection of the duplicate-account pattern. The action is a bespoke Improve-only case dispatched through the shared `runImproveOnlyAccountAction` (so the Improve tab **and** the escalation-triage `customer_action` todo executor run one code path); founder/owner-gated at the Improve route; the executor refuses unless `duplicate_customer_id` is a real empty shell (0 orders/subs/points). The escalation-triage solver playbook now auto-catches the duplicate-account pattern and proposes `reassign_ticket_customer` → `send_magic_link` (+ `link_customer_accounts`). Shipped 2026-06-20.

## Brain updates (same PR)
[[box-ticket-improve]] (expanded action set) · [[../orchestrator-tools]] · [[../libraries/magic-link]] · [[box-escalation-triage]] (pattern detection) · fold this spec on ship.
