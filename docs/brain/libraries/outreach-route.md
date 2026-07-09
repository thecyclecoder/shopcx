# libraries/outreach-route

Pure decision function that combines Phase 2's automated-sender pre-filter and Phase 1's classifier-bucket short-circuit into ONE testable predicate. Phase 3 of [[../specs/outreach-tickets-deterministically-close-no-sol-dispatch-no-ai-cost]].

**File:** `src/lib/outreach-route.ts`

## Why this exists

The unified-ticket-handler has TWO deterministic outreach short-circuits at different code sites (pre-classifier and post-classifier) — see [[../inngest/unified-ticket-handler]] §§ 1a2 + 1c. Duplicating the boolean logic inline at each site means the four Phase-3 verification tests would have to shadow the handler's control flow to pin their invariants; extracting the routing decision here means the SHIPPED handler and the tests both call `decideOutreachRoute`, so a green test suite proves the invariant on the code path prod actually runs (coaching #1's named-symbol acceptance token).

## Export

- `decideOutreachRoute(input: OutreachRouteInput): OutreachRoute`

### Input

```ts
interface OutreachRouteInput {
  isNew: boolean;
  senderEmail: string | null | undefined;
  body: string | null | undefined;
  classifierBucket?: "account" | "general" | "outreach";
  solFirstTouchEnabled?: boolean;
  agentAssigned?: boolean;
}
```

`classifierBucket` is intentionally optional. The pre-classifier call site (§ 1a2 in the handler) supplies undefined; the post-classifier call site (§ 1c) supplies the resolved `msgType`. Since Phase 2's check is FIRST in the function, the pre-classifier site's route is decided without ever touching `classifierBucket`.

### Return (discriminated union)

- `{ kind: "pre_filter_close", reason: "automated_sender_or_body_marker", solDispatched: false, classifierInvoked: false }` — Phase 2 lane. Fires when `isNew && isAutomatedInbound(senderEmail, body)`. The `classifierInvoked: false` bit is the ZERO-AI-COST invariant.
- `{ kind: "classifier_close", reason: "classifier_bucket_outreach", solDispatched: false, classifierInvoked: true }` — Phase 1 lane. Fires when the pre-filter missed AND `isNew && classifierBucket === "outreach"`.
- `{ kind: "continue", solDispatched: boolean, classifierInvoked: boolean }` — account/general path. `solDispatched` mirrors the handler's Sol first-touch predicate (`isNew && solFirstTouchEnabled && !agentAssigned && msgType !== "outreach"` — the last clause is guaranteed non-outreach by the time we hit `continue`), so tests can pin bullet (3) "normal customer email → classifier runs, Sol dispatched" directly on the return value.

## Callers

- [[../inngest/unified-ticket-handler]] § 1a2 (pre-classifier) — dispatches on `kind === "pre_filter_close"`, calls the `outreach-automated-sender-pre-filter` step.
- [[../inngest/unified-ticket-handler]] § 1c (post-classifier) — dispatches on `kind === "classifier_close"`, calls the `outreach-deterministic-close` step.

## Testing

`src/lib/outreach-route.test.ts` — 6 node:test cases (the 4 spec-verification bullets + 2 auxiliary pins). Run:

```
npx tsx --test src/lib/outreach-route.test.ts
```

Directly pinned bullets:
1. **outreach bucket → closed + tagged + zero ticket-handle jobs.** Human brand-collab email (Gmail from a UGC creator) → classifier returns `outreach` → `kind === "classifier_close"`, `solDispatched === false`, `classifierInvoked === true` (Haiku ran but it's cheap).
2. **no-reply sender → closed + tagged, classifier NOT called.** `testflight_no_reply@email.apple.com` → `kind === "pre_filter_close"`, `classifierInvoked === false` (ZERO AI cost).
3. **normal customer email → classifier runs, Sol dispatched.** Genuine customer asking about their order → `kind === "continue"`, `solDispatched === true`, `classifierInvoked === true`.
4. **brand-collab human outreach → closed, no Sol session.** Human agency outreach on `hello@growth-agency.io` → classifier returns `outreach` → `kind === "classifier_close"`, `solDispatched === false`.

Auxiliary pins: non-new / sol_first_touch_enabled=false / agentAssigned all return `{kind:"continue", solDispatched:false}`; body-only automated marker (human-looking sender + "please do not reply" in body) still trips the pre-filter.

## Related

- [[automated-sender]] — the underlying `isAutomatedInbound` predicate this dispatches through.
- [[../inngest/unified-ticket-handler]] — the caller.

---

[[../README]] · [[../../CLAUDE]]
