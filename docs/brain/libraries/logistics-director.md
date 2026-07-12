# libraries/logistics-director

Marco's **leash surface** module — pure config, no runtime behavior. Declares the code-level
`LEASH_CATEGORIES` array the runner + director-leash-guide + M3 dispatch key on. Currently EMPTY
by design: Marco lands as a **read-only observer** in the Message Center per
[[../specs/marco-logistics-director-seat]] Phase 3 (decision B from Phase 1 — the availability-toggle
has no callable server-side helper, and [[../functions/logistics]] § "Provenance / build model"
explicitly flags the whole tooling as off-limits to Ada by founder directive 2026-07-10). The
autonomous surface opens when [[../specs/marco-logistics-executor-surface]] lands the two
callable executors.

**File:** `src/lib/agents/logistics-director.ts` — pure config, safe to import from a client
component (no server imports, no side effects).

## Exports
- **`LeashCategory`** — `type LeashCategory = never` (empty union today). When
  marco-logistics-executor-surface lands the callable executors, this widens to
  `'availability_toggle_within_crisis_lever' | 'auto_readd_swapped_subscribers_within_crisis_cohort'`.
- **`LEASH_CATEGORIES: LeashCategory[]`** — `[]` today (read-only observer landing). The runner
  treats this as "nothing autonomous, everything escalates"; every pending_action on a logistics
  thread misses the M3 dispatch's in-leash check and routes UP to the CEO via
  `escalateApprovalRequestToCeo`.
- **`READ_ONLY: true`** — declarative marker distinct from "leash temporarily empty at deploy
  time." A future Marco with one auto category will not accidentally lose the read-only framing
  until this marker is explicitly flipped to `false`. Downstream surfaces MAY key on it (e.g.
  render Marco's tab with a "Read-only observer" subheader).

## How the read-only landing works end-to-end
1. **[[director-leash-guide]]** — `DIRECTOR_LEASH.logistics = LOGISTICS_LEASH` (this empty array).
   `getLeashGuide('logistics')` returns `defined:true` with `autonomous:[]` + only the generic
   CEO escalation rails.
2. **[[../tables/function_autonomy]]** — a dormant `logistics` row lands at `(live=false,
   autonomous=false)` via `supabase/migrations/20261016130000_logistics_director_function_autonomy_seed.sql`.
3. **M3 dispatch (`scripts/builder-worker.ts`)** — the `DISPATCH_TABLE.logistics` in-leash set is
   `new Set<string>()`. Every pending_action fails the check + escalates to the CEO with
   `directorLabelFor('logistics') = 'Marco (Logistics Director — read-only observer)'`.
4. **`directorCoachFraming('logistics')`** — Marco's coach thread carries a "READ-ONLY OBSERVER"
   framing that tells the model to investigate + explain but NEVER emit an executable
   pending_action. The `coachOutputFor('logistics')` block (`LOGISTICS_COACH_OUTPUT`) lists no
   card shapes — only the shared founder-prompted out-of-leash rail.
5. **[[director-activity]]** — a Marco thread's escalation writes a `director_activity` row with
   `director_function='logistics'` naming the read-only rail as the reason.

## North star
The read-only landing is a **legible bounded interim** — it is a first-class shape of "director
seat opened, autonomous surface intentionally closed for now" ([[../operational-rules]] §
North star: the supervisor's envelope is always legible, never aspirational). The `READ_ONLY`
marker prevents drift from "temporarily zero" (should reopen once cards ship) to "closed by
design" (stays closed until the follow-up spec opens it).

## Related
[[../functions/logistics]] · [[cs-director]] · [[growth-director]] · [[platform-director]] · [[director-leash-guide]] · [[../specs/marco-logistics-director-seat]] · [[../specs/marco-logistics-executor-surface]]
