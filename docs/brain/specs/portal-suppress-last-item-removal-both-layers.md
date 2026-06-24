# Suppress normalized 'would_remove_last_item' at both portal layers (ticket-create + triage), like insufficient_points ⏳

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `43742bcc-089c-4a55-a73e-ad29bf84fe29`

Ticket 43742bcc escalated as 'Unrecognized portal error' for a removelineitem that failed with the benign last-item guardrail. Its sibling validation error insufficient_points is suppressed in TWO layers — VALIDATION_ERRORS in src/app/api/portal/route.ts (prevents the ticket from ever being created) and the classifyPortalFailure dismiss branch in src/lib/portal/remediation.ts (backstop for already-created tickets). The normalized code 'would_remove_last_item' is in neither, so every legitimate last-item removal spawns a portal-action-failed ticket that the hourly cron then mis-routes to a human (its dismiss branch matches only raw Appstle text, not the code). Bring would_remove_last_item to parity with insufficient_points at both layers so these self-evidently-benign UI-gating failures never escalate and don't churn.

## Problem (from escalated ticket `43742bcc-089c-4a55-a73e-ad29bf84fe29`)
src/lib/portal/handlers/remove-line-item.ts (lines 51, 97) and src/lib/subscription-items.ts (line 238) normalize Appstle's last-item guardrail into the JSON error code 'would_remove_last_item' (friendly text returned as `detail`). src/app/api/portal/route.ts records body.error (the code) and body.message (not body.detail) into the portal.error event and the ticket note. PRIMARY layer: VALIDATION_ERRORS (route.ts:139) lists insufficient_points but NOT would_remove_last_item, so a last-item removal is logged and spawns a portal-action-failed ticket instead of being silently dropped like its sibling. BACKSTOP layer: classifyPortalFailure (remediation.ts:134) intends to dismiss this case but matches only the raw Appstle strings ('at least one subscription product' / 'cannot remove line item'), never the normalized code, so the cron escalates to a human (remediation.ts:161). Net effect: ticket-create → cron-dismiss churn plus an escalatable window. Two additional drift hazards to address while here: (a) other normalized codes returned by handlers in src/lib/portal/handlers/* may have the same raw-text-vs-code mismatch at both layers; (b) route.ts captures body.message but handlers carry the friendly text in body.detail, so any future validation code relying on text matching at the remediation layer is silently unmatchable — capture body.detail too, or standardize on stable codes.

**Likely target:** `src/app/api/portal/route.ts (add 'would_remove_last_item' to VALIDATION_ERRORS at line 139 — PRIMARY) AND src/lib/portal/remediation.ts (add 'would_remove_last_item' to the classifyPortalFailure dismiss branch at line 134 — BACKSTOP). Audit both layers for other normalized error codes against what each portal handler in src/lib/portal/handlers/* actually returns, and close the body.message-vs-body.detail capture gap in route.ts.`

## Phases
- ⏳ **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the escalation scenario → confirm the corrected behavior, and that the ticket that surfaced it would now be handled (or not mis-escalated).

> Authored by the box escalation-triage routine (solver+skeptic quorum) from escalated ticket `43742bcc-089c-4a55-a73e-ad29bf84fe29`. Commission the build from the Roadmap board (owner = cs).
