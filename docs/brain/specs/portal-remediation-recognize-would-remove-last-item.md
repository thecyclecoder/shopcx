# Portal remediation: dismiss `would_remove_last_item` instead of escalating it as unrecognized ⏳

**Priority:** critical

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `055e807d-7122-415f-8b45-82a88f57cc42`

Ticket 055e807d escalated as 'Unrecognized portal error' when a customer (Pam Chadwick) tried to remove the only product from a single-line subscription. The portal handled it correctly inline ('At least one recurring item must remain... Cancel the subscription instead.'), but the remediation classifier failed to recognize the outcome and escalated it to a human. This spec makes the classifier recognize the handler's actual friendly error code so this benign, expected case auto-dismisses (closes) like the system already intends.

## Problem (from escalated ticket `055e807d-7122-415f-8b45-82a88f57cc42`)
src/lib/portal/handlers/remove-line-item.ts normalizes BOTH the local last-item pre-check (line 51) and Appstle's live last-item guardrail (lines 96-97) to `jsonErr({ error: "would_remove_last_item", detail: "At least one recurring item must remain on the subscription. Cancel the subscription instead." }, 400)`. The portal route (src/app/api/portal/route.ts:189) stores this as `Error: would_remove_last_item` (the detail rides in `detail`, not `message`, so it's dropped from the note). But classifyPortalFailure() in src/lib/portal/remediation.ts (dismiss branch, line ~134) only matches the legacy RAW Appstle substrings `at least one subscription product` / `atleast one subscription product` / `cannot remove line item` — wording the handler no longer surfaces. The friendly code matches none, so it falls to the catch-all `human` disposition (line 161) and escalates. The legacy substrings are now effectively dead; the value that always reaches the classifier is `would_remove_last_item`. Every customer who tries to empty a single-product sub hits this and escalates instead of auto-dismissing.

**Likely target:** `src/lib/portal/remediation.ts — in classifyPortalFailure(), extend the existing last-item dismiss branch (~line 134) to also match `e.includes("would_remove_last_item")` and the friendly detail substring `at least one recurring item must remain`, keeping the legacy Appstle substrings as a fallback. Keep getFailureContext joining error+message so any future message text is preserved. Add/adjust a unit case so a ticket whose error is exactly `would_remove_last_item` classifies as dismiss. Update docs/brain/libraries/portal__remediation.md (classifyPortalFailure dismiss list) and note the fix on docs/brain/lifecycles/customer-portal.md. Owner: cs. Derived-from-ticket: 055e807d-7122-415f-8b45-82a88f57cc42.`

## Phases
- ⏳ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the escalation scenario → confirm the corrected behavior, and that the ticket that surfaced it would now be handled (or not mis-escalated).

> Authored by the box escalation-triage routine (solver+skeptic quorum) from escalated ticket `055e807d-7122-415f-8b45-82a88f57cc42`. Commission the build from the Roadmap board (owner = cs).
