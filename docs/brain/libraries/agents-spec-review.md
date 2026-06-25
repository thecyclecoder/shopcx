# libraries/agents-spec-review

The **spec-review** library — the typed verdict-applier + enqueue helper behind the box-hosted spec-review agent ([[../specs/spec-review-agent]]). **Vale** reviews every spec that lands in the `in_review` column (the build-pipeline hard-stop ahead of `planned`) against the authoring CHECKLIST and routes each one with a quality verdict; this module is the deterministic Node side that mutates state (the agent is read-only — see `runSpecReviewJob` in `scripts/builder-worker.ts`).

**File:** `src/lib/agents/spec-review.ts`

## Phase 3 — narrowed to QUALITY ONLY

The pipeline shape is **author → Spec Review (Vale, quality) → Director (Ada) disposes Planned vs Deferred → Build**. Vale's verdict is binary: `pass` or `needs_fix`. The planned/deferred call is Ada's (see [[agents-spec-dispose]]). The legacy `approve` / `defer` verdict strings still parse for back-compat (both auto-route as `pass`).

## Exports

### `selectInReviewSpecs(admin, workspaceId): Promise<string[]>`

The current `in_review` queue for one workspace — every `spec_card_state` row with `status='in_review'` (filtered through `effectiveStatusFromState` so a row marked `flags.deferred` never slips in). Used by the cron + the runner.

### `enqueueSpecReviewIfDue(workspaceId): Promise<{enqueued, reason?, pending?}>`

Insert ONE `agent_jobs` row `kind='spec-review'` for a workspace IFF there's ≥1 in_review spec AND no in-flight spec-review job. The `(spec-review-cron)` calls this per build-console workspace; future event triggers can call it too. Idempotent.

### `applySpecReviewDecision(workspaceId, decision): Promise<{ok, reason?, applied?}>`

Apply ONE Vale quality verdict to `spec_card_state` + record the audit row. Two branches:

- **pass** → `markSpecCardValePassed(ws, slug, { actor: 'spec-review', reason })` — sets `flags.vale_pass=true` so Ada's disposition lane can pick it up. Status STAYS `in_review`.
- **needs_fix** → leaves the spec in `in_review` (the build hard-stop holds); the diagnosis (`reason` + `defects[]`) is recorded as a `director_activity` row (`actor=spec-review`, `action_kind='spec_review_needs_fix'`).

Best-effort + idempotent — re-running the same verdict produces the same end state. Errors are swallowed (the box rerun catches them next cadence). Legacy `approve`/`defer` verdict strings auto-route as `pass`.

## Verdict types

```ts
export type SpecReviewVerdict = "pass" | "needs_fix";

export interface SpecReviewDecision {
  slug: string;
  verdict: SpecReviewVerdict;
  reason: string;        // one plain-text sentence the CEO + grader read
  defects?: string[];    // specific checklist failures — required when verdict='needs_fix'
}
```

## Director_activity action kinds

The agent stamps one of these `action_kind` values per spec ([[../tables/director_activity]]):

- `spec_review_passed` — well-formed (CHECKLIST cleared) → `flags.vale_pass=true`; spec stays in_review for Ada's disposition lane.
- `spec_review_needs_fix` — checklist failed (the `defects[]` list lives on the row's `metadata`).
- (legacy) `spec_review_approved` / `spec_review_deferred` — pre-Phase-3 Vale also routed planned/deferred; the writers are no longer emitted, but the enum values are retained for ledger continuity.

## Callers

- `src/lib/inngest/spec-review-cron.ts` — the 15-min periodic enqueuer.
- `scripts/builder-worker.ts` → `runSpecReviewJob` — claims the queued job, runs Vale on Max, applies every decision through `applySpecReviewDecision`, then runs Ada's disposition sweep ([[agents-spec-dispose]]) inline so a pass + dispose lands in one cron tick.
- (Future) on-demand send-back from the CEO via [[../specs/spec-review-agent]] Phase 4.

## Brain links

[[../specs/spec-review-agent]] · [[agents-spec-dispose]] · [[agent-grader]] (Vale's rubric in `AGENT_RUBRICS["spec-review"]`) · [[../inngest/spec-review-cron]] · [[../tables/director_activity]] · [[spec-card-state]] (the source of truth this library writes to) · [[../recipes/build-box-setup]]
