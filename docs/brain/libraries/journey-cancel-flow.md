# libraries/journey-cancel-flow

Single source of truth for the "does this journey completion route through the shared cancel handler?" decision in [[../lifecycles/cancel-flow]]. Pulled out of `src/app/api/journey/[token]/complete/route.ts` to fix the 11/22 regression where confirmed cancels were silently dropped (see Gotchas).

**File:** `src/lib/journey-cancel-flow.ts`

## Exports

### `resolveCancelFlow` — function

```ts
function resolveCancelFlow(config: Record<string, unknown>, cancelFlowFlag: boolean | undefined): boolean
```

Pure predicate. Returns `true` when ANY of:
- `config.cancelJourney === true` (explicit flag), OR
- `config.journeyType` is one of `'cancel_subscription' | 'cancellation' | 'cancel'` (a code-driven cancel session), OR
- `config.nextOrderJourney === true` AND `cancelFlowFlag === true` (an in-journey cancel confirmed from the next-order editor).

Otherwise `false`. The journeyType clause is what makes a cancel session reach the cancel handler even though its stored `config_snapshot` never carries `cancelJourney`.

Keeps the fb8f4a14 security rule: the client-supplied `cancel_flow` flag ALONE cannot route a non-cancel, non-next-order session (discount signup, add payment method, account linking, …) into the cancel path — it is honored only when the server-provisioned `config.nextOrderJourney === true`.

Covered by `src/lib/journey-cancel-flow.test.ts` (`npm run test:journey-cancel-flow`).

## Callers

- `src/app/api/journey/[token]/complete/route.ts` — computes `const cancelFlow = resolveCancelFlow(config, cancel_flow);` before the code-driven block, gating both the "skip the cancel handler" early return and the shared cancel/save-offer handler.

## Gotchas

- **Why this file exists (11/22 regression, 5b19a44c).** The route previously computed `cancelFlow` from `config.cancelJourney` BEFORE the code-driven block set `config.cancelJourney = true`. A cancel session's `config_snapshot` only carries `journeyType` (the GET loader adds `cancelJourney` to the live-rendered copy and never writes it back), so `cancelFlow` was `false`, the session was marked `outcome='cancelled'` and the customer was told it worked while the subscription kept billing. Deriving the decision from `journeyType` here removes the ordering trap.

---

[[../README]] · [[../lifecycles/cancel-flow]] · [[../tables/journey_sessions]] · [[../../CLAUDE]]
