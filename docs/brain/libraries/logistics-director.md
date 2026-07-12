# libraries/logistics-director

Marco's **leash surface** module — pure config, no runtime behavior. Declares the code-level
`LEASH_CATEGORIES` array the runner + director-leash-guide + M3 dispatch key on. Currently carries
two crisis-cohort categories: `availability_toggle_within_crisis_lever` + `auto_readd_swapped_subscribers_within_crisis_cohort`.
Marco landed as a **read-only observer** per [[../specs/marco-logistics-director-seat]] Phase 3,
then flipped to a **LIVE leash-bound director** with [[../specs/marco-logistics-executor-surface]]
Phase 2 (2026-07-12) — both executor branches are now callable and gated by the M3 dispatch's
`requireCrisis()` guard.

**File:** `src/lib/agents/logistics-director.ts` — pure config, safe to import from a client
component (no server imports, no side effects).

## Exports
- **`LeashCategory`** — `type LeashCategory = 'availability_toggle_within_crisis_lever' | 'auto_readd_swapped_subscribers_within_crisis_cohort'`.
  Started as `type LeashCategory = never` (empty) per [[../specs/marco-logistics-director-seat]]
  Phase 3 (read-only observer), then widened per [[../specs/marco-logistics-executor-surface]]
  Phase 2 to carry the two callable crisis-cohort executors.
- **`LEASH_CATEGORIES: LeashCategory[]`** — `['availability_toggle_within_crisis_lever', 'auto_readd_swapped_subscribers_within_crisis_cohort']`.
  The runner gates all pending_actions on this array; cards inside the array run the executor
  (both crisis-cohort gated), cards outside escalate to the CEO via `escalateApprovalRequestToCeo`.
- **`READ_ONLY: boolean`** — `false` post-Phase 2. Was `true` for the read-only observer landing.
  Flipped when the executor surface opened the two categories, so `coachOutputFor('logistics')`
  now emits the two card shapes (see [[../functions/logistics]]).

## How the executor surface wires end-to-end
1. **[[director-leash-guide]]** — `DIRECTOR_LEASH.logistics = LOGISTICS_LEASH` (now two categories).
   `getLeashGuide('logistics')` returns `defined:true` with `autonomous:[availability_toggle_within_crisis_lever, auto_readd_swapped_subscribers_within_crisis_cohort]`
   + the generic CEO escalation rails (anything outside the leash). The guide pairs each category with its plain-English title/detail from `CATEGORY_COPY`.
2. **[[../tables/function_autonomy]]** — the `logistics` row lives at `(live=false, autonomous=false)`
   (via the same seed migration as before). Marco's capability is now open (the two categories are
   callable), but the CEO has not flipped the `live` switch yet — all pending_actions still require
   explicit CEO approval before firing (no autonomous execution yet, only in-leash auto-approve pending CEO toggle).
3. **M3 dispatch (`scripts/builder-worker.ts`)** — the `DISPATCH_TABLE.logistics` in-leash set is
   `{ 'availability_toggle_within_crisis_lever', 'auto_readd_swapped_subscribers_within_crisis_cohort' }`.
   A card in this set runs the executor branch (either `setStorefrontAvailability` or bulk `crisis_customer_actions.auto_readd` update),
   gated by `requireCrisis()` (same-workspace crisis row + variant membership check). Out-of-leash cards escalate to CEO.
4. **`directorCoachFraming('logistics')`** — Marco's coach thread no longer carries the "READ-ONLY OBSERVER"
   framing. The `coachOutputFor('logistics')` block (`LOGISTICS_COACH_OUTPUT`) now lists the two card shapes
   plus the shared CEO escalation rails (anything unverifiable / out-of-leash).
5. **[[director-activity]]** — every in-leash approval writes a `director_activity` row with
   `director_function='logistics'` + `action_kind='storefront_availability_toggled'` (shape #1) or the crisis cohort action kind (shape #2);
   out-of-leash escalations write an `approval_decisions` row instead (CEO decided, director didn't).

## North star
The executor surface is a **legible bounded capability** — Marco can decide within the two
crisis-cohort categories, everything else escalates to the CEO ([[../operational-rules]] §
North star: the supervisor's envelope is always legible). The M3 dispatch's `requireCrisis()` guard
narrows the autonomy further: every executor branch verifies a real, same-workspace crisis row
before firing. The leash + the crisis guard are the two layers of CEO supervision over Marco's
autonomous actions.

## Related
[[../functions/logistics]] · [[cs-director]] · [[growth-director]] · [[platform-director]] · [[director-leash-guide]] · [[../specs/marco-logistics-director-seat]] · [[../specs/marco-logistics-executor-surface]]
