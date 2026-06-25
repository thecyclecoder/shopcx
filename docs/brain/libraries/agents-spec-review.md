# libraries/agents-spec-review

The **spec-review** library — the typed verdict-applier + enqueue helper behind the box-hosted spec-review agent ([[../specs/spec-review-agent]]). **Vale** reviews every spec that lands in the `in_review` column (the build-pipeline hard-stop ahead of `planned`) against the authoring CHECKLIST and routes each one with a verdict; this module is the deterministic Node side that mutates state (the agent is read-only — see `runSpecReviewJob` in `scripts/builder-worker.ts`).

**File:** `src/lib/agents/spec-review.ts`

## Exports

### `selectInReviewSpecs(admin, workspaceId): Promise<string[]>`

The current `in_review` queue for one workspace — every `spec_card_state` row with `status='in_review'` (filtered through `effectiveStatusFromState` so a row marked `flags.deferred` never slips in). Used by the cron + the runner.

### `enqueueSpecReviewIfDue(workspaceId): Promise<{enqueued, reason?, pending?}>`

Insert ONE `agent_jobs` row `kind='spec-review'` for a workspace IFF there's ≥1 in_review spec AND no in-flight spec-review job. The `(spec-review-cron)` calls this per build-console workspace; future event triggers can call it too. Idempotent.

### `applySpecReviewDecision(workspaceId, decision): Promise<{ok, reason?, applied?}>`

Apply ONE Vale verdict to `spec_card_state` + record the audit row. Three branches:

- **approve** → `markSpecCardStatus(ws, slug, 'planned', undefined, { actor: 'spec-review', reason })` so the build dispatch can claim it.
- **defer** → `markSpecCardStatus(ws, slug, 'deferred', …)` + `markSpecCardDeferred(ws, slug, true, …)` so status + display agree (the deferred flag wins via `effectiveStatusFromState`).
- **needs_fix** → leaves the spec in `in_review` (the build hard-stop holds); the diagnosis (`reason` + `defects[]`) is recorded as a `director_activity` row (`actor=spec-review`, `action_kind='spec_review_needs_fix'`).

Best-effort + idempotent — re-running the same verdict produces the same end state. Errors are swallowed (the box rerun catches them next cadence).

## Verdict types

```ts
export type SpecReviewVerdict = "approve" | "defer" | "needs_fix";

export interface SpecReviewDecision {
  slug: string;
  verdict: SpecReviewVerdict;
  reason: string;        // one plain-text sentence the CEO + grader read
  defects?: string[];    // specific checklist failures — required when verdict='needs_fix'
}
```

## Director_activity action kinds

The agent stamps one of three new `action_kind` values per spec ([[../tables/director_activity]]):

- `spec_review_approved` — sound + needed now → status flipped to `planned`.
- `spec_review_deferred` — sound but parked per the spec's own directive → status `deferred` + `flags.deferred` set.
- `spec_review_needs_fix` — checklist failed (the `defects[]` list lives on the row's `metadata`).

## Callers

- `src/lib/inngest/spec-review-cron.ts` — the 15-min periodic enqueuer.
- `scripts/builder-worker.ts` → `runSpecReviewJob` — claims the queued job, runs Vale on Max, applies every decision through `applySpecReviewDecision`.
- (Future) on-demand send-back from the CEO via [[../specs/spec-review-agent]] Phase 3.

## Brain links

[[../specs/spec-review-agent]] · [[agent-grader]] (Vale's rubric in `AGENT_RUBRICS["spec-review"]`) · [[../inngest/spec-review-cron]] · [[../tables/director_activity]] · [[spec-card-state]] (the source of truth this library writes to) · [[../recipes/build-box-setup]]
