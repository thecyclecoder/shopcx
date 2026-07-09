# sol-mechanism-arm

`src/lib/sol-mechanism-arm.ts` — the box session's **reply-gated arm** of the mechanism Sol chose at first touch.

## Why

Founder directive (2026-07-09): Sol's first-touch box session ([[../../scripts/builder-worker]] `runTicketHandleJob`) writes the opening reply, and the chosen **playbook must then be armed** so it takes over on the customer's NEXT reply — never dormant (waiting on a reply that never arms it), never double-sending (Sol's opening + the playbook's first message at once). Before this, the box authored the Direction + sent the reply and stopped; the playbook only armed later, on the next inbound, via [[./sol-direction-apply]]. Ticket `125741eb` (marty) exposed it: the refund Direction sat authored-but-dormant and the ticket stayed open.

## The mechanism split

- **Playbooks are reply-driven.** The `sol-playbook-shortcircuit` in [[../inngest/unified-ticket-handler]] runs [[./playbook-executor]] `executePlaybookStep` whenever `tickets.active_playbook_id` is set and a customer replies. So arming = `armPlaybook` ([[./tickets-mutate]]) — a pure state-set that **sends nothing**. Reply-gated by construction.
- **Journeys are CTA-driven** (self-service, token-authed button clicks — not the reply handler). "Arming" a journey means Sol's opening must CARRY the CTA (a send-path change), NOT a silent state-set. Deliberately out of scope here.

## The resume step (the crux)

Sol's opening reply already delivered the playbook's customer-facing `apply_policy`/stand-firm step plus the silent identify/check steps before it. Re-running those on the next reply would repeat her message. So the box arms at the step AFTER the leading identify/check/apply_policy prefix — the first offer/action step.

`computeResumeStep(stepTypes)` = the count of leading, contiguous steps whose `type` ∈ `OPENING_PREFIX_STEP_TYPES` (`identify_order`, `identify_subscription`, `identify_customer`, `check_other_subscriptions`, `apply_policy`). For the **refund** playbook (`identify_order · identify_subscription · check_other_subscriptions · apply_policy · offer_exception · initiate_return · cancel_subscription · stand_firm`) that resolves to **step 4 (`offer_exception`)**. A trailing `stand_firm` (step 7) is not part of the leading prefix, so it never pulls the pointer past the offers.

If every step is prefix (`resumeStep >= steps.length`), the playbook is left un-armed (`no_post_opening_step`) — Sol's reply completed its arc; the close still fires.

## Exports

| Symbol | Purpose |
|---|---|
| `OPENING_PREFIX_STEP_TYPES` | the step-type set Sol's opening covers |
| `computeResumeStep(stepTypes)` | index of the first step after the opening prefix (unit-tested) |
| `armSolPlaybookReplyGated(admin, {workspaceId, ticketId, playbookSlug, seedContext})` | look up the active playbook + steps, compute the resume step, seed context, `armPlaybook`. Returns `{armed, playbookId, resumeStep, reason}` — never throws for a lookup miss. Skips a ticket already mid-playbook (`already_active`). |

**Seed context:** Sol's `plan.playbook_seed_context` wins; otherwise the disputed (most-recent) order + its subscription are derived so the resumed offer/return steps have the identify context the skipped steps would have populated. `playbook_intro_sent: true` is always set so [[./playbook-executor]] doesn't re-wrap its next message as a fresh greeting.

## Callers

`runTicketHandleJob` in [[../../scripts/builder-worker]] — after Sol's opening reply ships (`chosen_path='playbook'`), then the ticket closes ([[./ticket-directions]] `classifySolBoxTurnAction`: every shipped Sol message closes; a reply reopens and the armed playbook drives).

Related: [[./sol-direction-apply]] (the legacy on-reply arm, still the fallback), [[./playbook-executor]], [[./tickets-mutate]] `armPlaybook`, [[./ticket-directions]].
