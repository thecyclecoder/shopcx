# libraries/crisis-events

The write chokepoint for [[../tables/crisis_events]]: the one place a crisis row is created or activated.

**File:** `src/lib/crisis-events.ts` · test: `src/lib/crisis-events.test.ts` (`npm run test:crisis-events`)

## Why

Until 2026-11-24 the only creator was the dashboard POST route's inline insert. When Sleep Gummies Berry hit 0 on hand at Amplifier with 16 stuck orders, an agent had no way to stand up a crisis without a raw `.from("crisis_events").insert(...)`, which CLAUDE.md forbids. The dashboard route and agents now share this SDK, so defaults and validation can't drift.

## Exports

- `buildCrisisRow(workspaceId, input)`: PURE. Validates `name` + `affected_variant_id` (throws when either is missing), trims the name, and applies `CRISIS_DEFAULTS` (status `draft`, tier-2 coupon 20%, lead time 7 days, tier wait 3 days). An explicit `0` coupon percent is kept.
- `createCrisisEvent(admin, workspaceId, input)`: inserts the row in `draft` and returns it; throws on a DB error.
- `activateCrisisEvent(admin, workspaceId, crisisId)`: flips `draft` to `active` with a compare-and-set on `status='draft'`, so an active or resolved crisis is never moved back. Returns true only when this call moved it.
- `CRISIS_DEFAULTS`, `CreateCrisisInput`, `CrisisSwapOption`, `CrisisStatus`.

Resolving stays on the dashboard's `POST .../crisis/[crisisId]` `action=resolve` path, because resolving also restores enrolled subscriptions.

## Callers

- `src/app/api/workspaces/[id]/crisis/route.ts` POST (dashboard create form).
- Agents and one-off scripts creating a crisis.

Readers: [[crisis-substitution]] `getSubstitutionCrises`, [[crisis-journey-builder]], [[crisis-restart-swap]].
