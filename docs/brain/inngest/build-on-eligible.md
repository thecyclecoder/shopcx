# inngest/build-on-eligible

The **reactive companion** to the `*/5` [[platform-director-cron]] for the **build lane** ([[../specs/bo-reactive-gated-build-enqueue]] Phase 2). Sibling of the [[../specs/vale-reactive-spec-review]] pattern for Vale — fire an event on the transitions that make a spec build-eligible, run the [[../libraries/agent-jobs]] `enqueueBuildIfDue` gate on receipt. The cron becomes the **gated backstop** for dropped events / cold workspaces.

**File:** `src/lib/inngest/build-on-eligible.ts` (registered in `src/lib/inngest/registered-functions.ts`)

## Functions

### `build-on-eligible`
- **Trigger:** `event: 'build/spec-build-eligible'` (payload `{ workspace_id, slug }`)
- **Retries:** 1
- **Concurrency:** `[{ limit: 1, key: 'event.data.workspace_id' }]` — one build-eligibility check per workspace at a time; a burst of transitions on the same workspace serializes into a single ordered chain.

## Body

Single call to [[../libraries/agent-jobs]] `enqueueBuildIfDue(workspace_id, slug)` — the same cheap-SDK-gate + one-in-flight chokepoint the cron uses. Because that helper re-checks the FULL build-eligibility gate (`specReviewDone` + `!deferred` + `!in_review` + `auto_build !== false` + blockers cleared + not shipped + not in-flight), firing on the Vale pass alone is safe: if the spec still needs Ada's disposition the consumer no-ops for free with `reason:'in-review-pending-disposition'` (fix-bo-reactive-gated-build-enqueue-a3f2e4), and the second event (from Ada) re-fires when it lands.

## Who fires the event

Fire-and-forget from the two writers in [[../libraries/spec-card-state]]:

- **`markSpecCardValePassed`** — Vale passing the spec (stamps `specs.vale_review_passed_at`). This is the `in_review` pass the CEO named as the reactive trigger.
- **`applyAdaDisposition('planned')`** — Ada moving the spec out of `in_review` into the buildable lane. NOT fired for a `deferred` disposition (the gate would no-op anyway; parking is intentional).

Both use the untyped `@/lib/inngest/client` `inngest.send({ name: 'build/spec-build-eligible', data: { workspace_id, slug } }).catch(() => {})` shape — a broken event pipe must never break the underlying card write. Same pattern as `brain/index.refresh` in `roadmap-actions.ts:503`.

## Why fire on both

Either transition alone may make the spec eligible: a Vale pass on an already-planned/queued dependent, or Ada disposing a pre-passed spec after a re-review. The gate is idempotent + cheap (one `getSpec` read + one `.select("id").limit(1)` for the in-flight check), so a double-fire is a wasted SDK read, not a duplicate build row.

## Cron vs event

- **Event** (this) — near-real-time; typical latency = one Inngest event round-trip.
- **Cron** ([[platform-director-cron]] `*/5`) — the gated backstop. Its lanes already gate on `specReviewDone` (via [[../libraries/platform-director]] `isBuildableSpec`), so it only catches dropped events / cold workspaces without risking a double-enqueue: `enqueueBuildIfDue`'s one-in-flight guard makes a cron tick that races an event a clean no-op.

## Downstream

_None._ The box polls [[../tables/agent_jobs]] and claims the row Bo needs to build; there is no HTTP call into the box.

## Tables written

- [[../tables/agent_jobs]] — via `enqueueBuildIfDue`, one `kind='build'` row per (workspace, slug) when the gate clears.

## Tables read (not written)

- [[../tables/specs]] — via `getSpec` inside `enqueueBuildIfDue` (eligibility gate).
- [[../tables/agent_jobs]] — in-flight dedupe inside `enqueueBuildIfDue`.

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/agent-jobs]] · [[../libraries/spec-card-state]] · [[platform-director-cron]] · [[../specs/bo-reactive-gated-build-enqueue]]
