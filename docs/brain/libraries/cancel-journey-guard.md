# libraries/cancel-journey-guard

Pure predicates + one thin DB helper that keep a customer who's completed the cancel journey into a `saved_%` outcome from being trapped when they immediately re-ask to cancel.

**File:** `src/lib/cancel-journey-guard.ts`

## Why this exists

Ticket `6c12a925-8851-4a07-b7be-6ba6234d842f` (Afi, 2026-08) surfaced the trap:

1. Customer completes the cancel journey ([[../journeys/cancel]]) → `journey_sessions.outcome='saved_remedy'`, ticket replies **"We've updated your subscription. Thank you for staying with us!"**
2. Customer immediately re-asks in words: *"Cancel my subscription"* — three inbound messages in a row.
3. Every downstream path treats the accepted save as authoritative. A fresh cancel journey re-launched from the orchestrator re-presents the SAME remedy step. [[action-executor]] `directActionHandlers` exposes no cancel action, so [[no-progress-guard]] escalates to human review with no in-leash tool.
4. `subscription 2fbe0503` stays active with the next renewal locked in. The one save the customer accepted (or mis-clicked) blocks the cancellation she keeps requesting.

This module is the structural fix: detect the trap deterministically, so [[journey-delivery]] can route the next cancel-journey delivery straight to confirm-cancel (skipping remedies) and [[no-progress-guard]] can re-send that shortened journey instead of dead-ending at human review.

## Exports

### `looksLikeCancelIntent(body) → boolean` — pure

Loose free-text detector for a cancel-my-subscription-style message. Strips HTML, lowercases, checks against a small list of ACTION-verb phrases (`cancel my subscription`, `please cancel`, `stop charging me`, `unsubscribe me`, plus common misspellings `cancle` / `cancell` / `canel` mirrored from the `journey_definitions.match_patterns` list). Negative-context short-circuit: `cancelled by the carrier` / `cancelled by shipper` / `cancelled by UPS` don't fire (a shipping ticket that mentions the word "cancelled" isn't a cancel request).

Deliberately narrower than the DB pattern list — the DB list optimizes for RECALL (a journey shouldn't be missed), this predicate optimizes for PRECISION inside a no-progress loop where the cost of a false positive is re-sending a journey the customer didn't want.

Tested in `src/lib/cancel-journey-guard.test.ts` (named failing state: `"Cancel my subscription"` on a ticket with prior `saved_remedy` must trip).

### `hasRecentSavedRemedy(admin, workspaceId, ticketId) → { hasSavedRemedy, sessionId, completedAt }`

Thin DB helper — queries [[../tables/journey_sessions]] for the most recent `status='completed'` row on THIS ticket whose `outcome ILIKE 'saved_%'`. Returns `hasSavedRemedy=true` when found so the caller can force the terminal route.

Scoped by `ticket_id` (not `customer_id`) — the trap is within the SAME support ticket. Uses `ilike 'saved_%'` so `saved_remedy`, `saved_changed_mind`, and any future `saved_*` outcome all count. A ticket whose only completed session came out `cancelled` returns `false` — that outcome is terminal (ticket closed).

### `isCancelTriggerIntent(intent) → boolean` + `CANCEL_TRIGGER_INTENTS`

Set / predicate for the trigger_intent flavors the cancel journey uses today (`cancel_subscription`, `cancel`, `cancellation`). Kept aligned with the [[../tables/journey_definitions]] row for the cancel journey.

## Callers

- [[journey-delivery]] `launchJourneyForTicket` — for a cancel-intent launch, auto-invokes `hasRecentSavedRemedy` and stamps `config_snapshot.directToCancelTerminal=true` when true. The mini-site reads that flag and jumps straight to `confirm_cancel` after the subscription resolves ([[../journeys/cancel]] § "Route past remedies on re-request").
- [[no-progress-guard]] `applyNoProgressCircuit` — when the 3-inbound streak trips AND any of those inbounds trips `looksLikeCancelIntent`, calls `attemptCancelJourneyResend` (which internally goes through `launchJourneyForTicket` → auto-detect) INSTEAD of firing the escalation. Cancellation still completes only via the customer's own confirm button.

## Gotchas

- `looksLikeCancelIntent` scans FIRST inbound in the streak first. If a customer's streak is `["invoice question", "invoice question", "cancel it"]` the last one still trips — deliberately: any clear cancel ask in the stuck window is enough.
- The predicate deliberately does NOT match a bare `"cancel"` — too many false positives ("cancel the last order", "cancel the change"). Requires an action-verb phrase.
- **Not a policy override.** This guard doesn't cancel FOR the customer — it just routes them to the button they were about to click anyway. `directActionHandlers` still exposes no cancel action, and Sol's self-service-only rule still holds.

---

[[../README]] · [[../../CLAUDE]]
