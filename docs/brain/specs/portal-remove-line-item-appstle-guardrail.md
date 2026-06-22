# Treat Appstle 'last subscription product' 400 as a handled would_remove_last_item, not a server ERR ⏳

**Owner:** [[../functions/retention]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/subscription-items.ts (appstleremovelineitem: detect status===400 with body matching must be present in a subscription / usergeneratederror, log at warn not console.error, return { success:false, error:would_remove_last_item }; and src/lib/portal/handlers/remove-line-item.ts: map that error to the existing friendly 400)::real-bug`
**Repair-signature:** `vercel:0dda1c7b9495ebb1`

When the local remaining-items pre-check is stale relative to Appstle's live contract, Appstle's own authoritative guardrail rejects the removal with a 400 UserGeneratedError ('Atleast one subscription product must be present'). Today appstleRemoveLineItem console.errors this expected, user-generated guardrail as a hard server ERR and the portal returns an opaque 502, so a benign 'you can't empty your subscription' outcome both floods the Vercel error feed and shows the customer a confusing failure. Recognize this specific Appstle response and fold it into the existing friendly would_remove_last_item path.

## Problem (from Control Tower signature `vercel:0dda1c7b9495ebb1`)
appstleRemoveLineItem (src/lib/subscription-items.ts:221-225) treats every non-2xx Appstle response identically: console.error('[appstleRemoveLineItem] error:', res.status, text) + a generic error string, which handleAppstleError turns into a 502. The remove-line-item handler's local guard (remove-line-item.ts:50) only catches the last-item case when subscriptions.items is accurate; when that snapshot is stale-high vs Appstle's live contract, the guard passes and Appstle's 400 UserGeneratedError ('Cannot remove line item. Atleast one subscription product must be present in a subscription') leaks through as a logged ERR (signature vercel:0dda1c7b9495ebb1) and an opaque 502.

**Likely target:** `src/lib/subscription-items.ts (appstleRemoveLineItem: detect status===400 with body matching 'must be present in a subscription' / 'UserGeneratedError', log at warn not console.error, return { success:false, error:'would_remove_last_item' }; and src/lib/portal/handlers/remove-line-item.ts: map that error to the existing friendly 400)`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:0dda1c7b9495ebb1`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:0dda1c7b9495ebb1` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
