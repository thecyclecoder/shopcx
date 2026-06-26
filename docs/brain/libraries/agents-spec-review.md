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
- `scripts/builder-worker.ts` → `runSpecReviewJob` — claims the queued job, runs Vale on Max, applies every decision through `applySpecReviewDecision`, then runs Ada's disposition sweep ([[agents-spec-dispose]]) inline so a pass + dispose lands in one cron tick. The poll loop carries an OWN concurrency-1 `spec-review` claim lane (`MAX_SPEC_REVIEW=1`, `countSpecReview()`, Claude-down-gated like the other read-only Max agents — repair/regression/security-review/spec-test). Before this lane existed the cron's queued jobs sat unclaimed and `loop:agent:spec-review` went silent (Control Tower repair signature).

## Phase 4 — back-to-review (the shared mandate)

[[../specs/spec-review-agent]] Phase 4 generalized the in_review lane: any agent that spots a malformed/off spec mid-flight flips the card back to `in_review` via [[spec-card-state]]'s `markSpecCardBackToReview` writer, so it returns to Vale's queue. The build pipeline refuses to dispatch an in_review spec — that's the whole point: don't build around a broken spec.

The mandate applies to:
- **Vale** (here) — a `needs_fix` verdict KEEPS the spec in `in_review` (no flip needed, but the same lane is enforced).
- **Bo** (the build skill) — `.claude/skills/build-spec/SKILL.md` extends the empty/phaseless surface to ALL CHECKLIST defects: stop and surface `needs_input`, and the worker (or operator) flips the card back to `in_review` rather than patching it inline.
- **Ada** (her chat-surface `spec-status` action) — emit `{type:'spec-status', slug, status:'in_review', reason}` to send a spec back to in_review (`applySpecStatusActionInline` in `scripts/builder-worker.ts` routes it through `markSpecCardBackToReview`).
- **Repair / Regression** — when authoring a fix that'd extend an existing spec, if that spec is malformed the verdict is `needs-human` with the diagnosis; never silently patch a malformed parent.
- **The CEO board control** — `POST /api/roadmap/status` accepts `status:'in_review'` (segment in `src/app/dashboard/roadmap/StatusControl.tsx`). Routes through `markSpecCardBackToReview` + records a `spec_sent_back_to_review` `director_activity` row with `actor=owner:{user_id}`.

Every back-to-review write records a `director_activity` row with `action_kind='spec_sent_back_to_review'` so the CEO sees who sent it back and why.

## Brain links

[[../specs/spec-review-agent]] · [[agents-spec-dispose]] · [[agent-grader]] (Vale's rubric in `AGENT_RUBRICS["spec-review"]`) · [[../inngest/spec-review-cron]] · [[../tables/director_activity]] · [[spec-card-state]] (the source of truth this library writes to) · [[../recipes/build-box-setup]]
