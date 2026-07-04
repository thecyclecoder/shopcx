# libraries/agents-spec-review

The **spec-review** library — the typed verdict-applier + enqueue helper behind the box-hosted spec-review agent ([[../specs/spec-review-agent]]). **Vale** reviews every spec that lands in the `in_review` column (the build-pipeline hard-stop ahead of `planned`) against the authoring CHECKLIST and routes each one with a quality verdict; this module is the deterministic Node side that mutates state (the agent is read-only — see `runSpecReviewJob` in `scripts/builder-worker.ts`).

**File:** `src/lib/agents/spec-review.ts`

## Phase 3 — QUALITY + a reasoned disposition proposal (vale-reasons-the-disposition)

The pipeline shape is **author → Spec Review (Vale, quality + disposition proposal) → Director (Ada) disposes Planned vs Deferred → Build**. Vale's verdict is binary: `pass` or `needs_fix`. On a `pass`, [[../specs/vale-reasons-the-disposition]] Phase 1 additionally has Vale emit a reasoned planned/deferred recommendation with a plain-text WHY (`disposition` + `disposition_reason`) — hydrated once, extra verdict free. The recommendation persists on `specs.vale_disposition` + `specs.vale_disposition_reason`; Ada's disposition sweep consumes it in Phase 2 (retiring the trust-the-author stub). Ada still DISPOSES via the asymmetric CEO-gated routing (see [[agents-spec-dispose]]) — Vale only PROPOSES. The legacy `approve` / `defer` verdict strings still parse for back-compat (both auto-route as `pass`).

## Phase 1 coaching hardening — mandate baked in (agent-mandate-hardening-spec-review)

[[../specs/agent-mandate-hardening-spec-review]] rolled 11 accumulated coaching attempts into Vale's permanent mandate in `scripts/builder-worker.ts` `runSpecReviewJob` + `.claude/skills/spec-review/SKILL.md`. The coaching that stuck:

- **QUALITY-ONLY Phase 3 scope:** Vale's verdict is literal `pass` or `needs_fix`. Ada owns planned/deferred disposition — Vale NEVER emits `disposition`/`disposition_reason` (a lane violation the rubric penalises). The applier `applySpecReviewDecision` defends this: `disposition` on a `pass` hydrates `specs.vale_disposition` for Ada's sweep; on a `needs_fix` it is ignored (an ill-formed spec is not dispositionable).
- **DB-BACKED GOAL-PARENT validation:** the prompt pre-resolves every goal in the workspace via [[../libraries/goals-table]] `listGoals(workspaceId)` → a GOAL-PARENT LOOKUP block injected into the prompt. When a spec's `Parent:` names `[[../goals/{slug}]]` or a milestone anchor, Vale validates it against the DB rows (the canonical source) instead of the purged `docs/brain/goals/*.md` filesystem. A goal slug present in the DB index RESOLVES — no `needs_fix` on missing-file grounds (the markdown path was intentionally deleted; see [[../specs/spec-pm-markdown-purge]]). A milestone-anchored parent (`[[../goals/{slug}#M{id}]]`) resolves IFF the milestone's uuid matches the DB row. A parent naming only the goal when the DB shows ≥1 milestone IS a defect (specs must anchor to a specific milestone, not the general goal).
- **EVIDENCE CONTRACT — structured reasoning per verdict:** every verdict's `reason` field enumerates all six CHECKLIST checks by number with the actual RESULT of each check (e.g., "spec {slug}: (1) phases 1-3 contiguous each with ### Verification; (2) Owner [[../functions/growth]] resolves; (3) Parent [[../goals/acq-engine#M4]] resolves via DB index; (4) no prerequisites named in body → Blocked-by not required; (5) no customer_id table; (6) all phases carry Verification — no defects, verdict pass, stayed in Phase 3 quality lane"). Bare verdicts ("looks good", "passes") cap grading at 6/10 because graders cannot verify genuine checks against lucky flags or false positives; field-level evidence makes the diagnosis auditable and proves Phase 3 lane discipline.
- **Slug verbatim discipline:** `decisions[].slug` MUST match a queued `.box/spec-{slug}.md` path exactly. The prompt hardcodes the queue (`.box/spec-{slug-here}.md`), and the worker validates: `queuedSet.has(d.slug)` skips any decision whose slug is NOT in the materialized queue. A slug re-derived from the H1 title or abbreviated from the summary is silently dropped (the spec stays un-triaged), turning an otherwise-correct review into a 0-findings no-op.
- **Defect-specificity on needs_fix:** quoted the exact offending field or section from the markdown (e.g., "duplicate '## Phase 1' heading at :34 and :52"; "no '**Owner:**' line"; "**Parent:** [[../goals/x]] names only the goal but DB shows milestones M1/M2/M3"). Bare defect strings without field/line references hide the diagnosis from graders and commit future reviewers to re-inspecting the spec manually.
- **Empty-queue no-op guardrail:** the run-job reads the in_review pool at start; if empty (every spec shipped/deferred/sent-back while the job was queued), it early-returns `completed` instead of launching Vale on nothing. If Vale runs but returns "no parseable decisions", the job re-checks the pool — if still empty, completes as a no-op (not a real failure); only a parse failure over a still-populated queue parks `needs_attention` (a genuine malformed-output failure on real input).

Regression-locked by [[../specs/agent-mandate-hardening-spec-review]] Phase 1 verification checks and replayed via the [[../libraries/agent-grader]] `AGENT_RUBRICS["spec-review"]` Phase 3 rubric.

## Exports

### `selectUnreviewedInReviewSpecs(admin, workspaceId): Promise<string[]>`

The current Vale queue for one workspace — every `public.specs` row with `status='in_review'` AND `deferred=false` AND `vale_pass !== true` (i.e. in_review specs that LACK a current Vale review). Introduced by [[../specs/vale-reactive-spec-review]] Phase 1; the earlier `selectInReviewSpecs` returned the full non-deferred in_review pool and re-scheduled Vale even when every spec had already passed. The durable review signal keys to spec CONTENT: `markSpecCardBackToReview` NULLs `vale_pass` on every re-open / re-author and a fresh authoring leaves it null (`upsertSpec` DB default) — so a `vale_pass=true` spec is parked for Ada's disposition lane, NOT part of Vale's queue. Used by the cron backstop + the runner + (Phase 2) the reactive event consumer.

### `enqueueSpecReviewIfDue(workspaceId): Promise<{enqueued, reason?, pending?}>`

Insert ONE `agent_jobs` row `kind='spec-review'` for a workspace IFF ≥1 in_review spec LACKS a current Vale review AND no in-flight spec-review job. Two triggers flow through here: the 15-min [[../inngest/spec-review-cron]] (catch-up backstop) and the reactive [[../inngest/spec-review-on-mutate]] consumer (fires within seconds of a fresh author / send-back — [[../specs/vale-reactive-spec-review]] Phase 2). Idempotent — the free SDK check inside this helper is the whole point of the gate; an expensive box `claude -p` only spins up when there is real, unreviewed work.

`reason` disambiguates the empty-pool cases:

- `no-in-review-specs` — no non-deferred in_review specs exist at all.
- `no-unreviewed-specs` — in_review pool is non-empty but every spec already carries `vale_pass=true` (parked for Ada's disposition lane, not Vale's queue).
- `in-flight` — a `spec-review` job is already queued/running for this workspace.
- `insert-failed: …` — the row insert failed (transient DB error; the cron backstop retries next tick).

### `applySpecReviewDecision(workspaceId, decision): Promise<{ok, reason?, applied?}>`

Apply ONE Vale quality verdict to `spec_card_state` + record the audit row. Two branches:

- **pass** → `markSpecCardValePassed(ws, slug, { actor: 'spec-review', reason }, dispositionOpt?)` — sets `flags.vale_pass=true` so Ada's disposition lane can pick it up. When the decision carries a `disposition` + `disposition_reason` (vale-reasons-the-disposition Phase 1), they land on `flags.vale_disposition` + `flags.vale_disposition_reason` (mirrored to the same-named `specs` columns via [[spec-card-state]] `dualWriteSpecRow`). Status STAYS `in_review`.
- **needs_fix** → leaves the spec in `in_review` (the build hard-stop holds); the diagnosis (`reason` + `defects[]`) is recorded as a `director_activity` row (`actor=spec-review`, `action_kind='spec_review_needs_fix'`). Any `disposition` on a needs_fix is IGNORED (an ill-formed spec is not dispositionable yet).

Best-effort + idempotent — re-running the same verdict produces the same end state. Errors are swallowed (the box rerun catches them next cadence). Legacy `approve`/`defer` verdict strings auto-route as `pass`.

## Verdict types

```ts
export type SpecReviewVerdict = "pass" | "needs_fix";

export interface SpecReviewDecision {
  slug: string;
  verdict: SpecReviewVerdict;
  reason: string;                          // one plain-text sentence the CEO + grader read
  defects?: string[];                      // specific checklist failures — required when verdict='needs_fix'
  disposition?: "planned" | "deferred";    // vale-reasons-the-disposition Phase 1 — recommendation on a PASS
  disposition_reason?: string;             // plain-text WHY paired with disposition (CEO sees it verbatim on UPGRADE/DOWNGRADE)
}
```

## Director_activity action kinds

The agent stamps one of these `action_kind` values per spec ([[../tables/director_activity]]):

- `spec_review_passed` — well-formed (CHECKLIST cleared) → `flags.vale_pass=true`; spec stays in_review for Ada's disposition lane. vale-reasons-the-disposition Phase 1 — when the pass carried a `disposition` + `disposition_reason`, both are recorded on the row's `metadata.vale_disposition` + `metadata.vale_disposition_reason` (the same reason surfaces on `specs.vale_disposition_reason` for Ada's sweep + CEO surfaces).
- `spec_review_needs_fix` — checklist failed (the `defects[]` list lives on the row's `metadata`).
- (legacy) `spec_review_approved` / `spec_review_deferred` — pre-Phase-3 Vale also routed planned/deferred; the writers are no longer emitted, but the enum values are retained for ledger continuity.

## Callers

- `src/lib/inngest/spec-review-cron.ts` — the 15-min periodic enqueuer (catch-up backstop).
- `src/lib/inngest/spec-review-on-mutate.ts` — the reactive `spec-review/spec-mutated` consumer that fires the same gated helper within seconds of a spec create / re-open ([[../specs/vale-reactive-spec-review]] Phase 2).
- `src/lib/author-spec.ts` + `src/lib/spec-card-state.ts` `markSpecCardBackToReview` — fire the `spec-review/spec-mutated` event after the mutation writes ([[../specs/vale-reactive-spec-review]] Phase 2).
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

## Gotchas

- **Empty-queue NO-OP — never park on nothing.** The sweep (sentinel job `spec_slug='spec-review-sweep'`) must NO-OP gracefully when there are ZERO `in_review` specs — it must NOT launch Vale and must NOT park a `needs_attention` job on empty input. Three gates enforce this:
  1. `enqueueSpecReviewIfDue` returns `{enqueued:false, reason:"no-in-review-specs"}` or `{enqueued:false, reason:"no-unreviewed-specs"}` when `selectUnreviewedInReviewSpecs` is empty (enqueue-side gate, [[../specs/vale-reactive-spec-review]] Phase 1), and the standing backstop in `runSpecReviewJob`'s poll loop only enqueues `if (inReview.length)`.
  2. `runSpecReviewJob` re-reads `selectUnreviewedInReviewSpecs` at run start; an empty pool early-returns `status='completed'` (runs only Ada's disposition sweep) — never launches the agent.
  3. **Defensive:** if Vale DOES run and returns "no parseable decisions", `runSpecReviewJob` re-reads the in_review pool — if it has DRAINED to 0 since enqueue (every spec shipped/deferred/sent-back while the job sat queued), the job completes as a benign no-op instead of parking. Only a parse failure over a STILL-POPULATED queue parks (a genuine malformed-output failure on real input).
  - **Why this matters (the phantom-park bug, 2026-06-27):** before gate 3, a sweep launched with an empty/drained queue produced "spec-review produced no parseable decisions", parked `needs_attention`, retried to the 3-attempt cap, then Ada (platform-director) re-escalated the dead park on EVERY standing pass — pure noise (no work to do). 3 such phantoms in workspace `fdc11e10-…` were dismissed (`status='dismissed'`, `needs_attention_class='dismissed_by_director'`) + 9 matching `dashboard_notifications` ("Park needs eyes / Parked spec-review: spec-review-sweep") cleared via the one-off `scripts/_clear-phantom-spec-review-parks.ts`.

## Brain links

[[../specs/spec-review-agent]] · [[../specs/vale-reactive-spec-review]] · [[agents-spec-dispose]] · [[agent-grader]] (Vale's rubric in `AGENT_RUBRICS["spec-review"]`) · [[../inngest/spec-review-cron]] · [[../inngest/spec-review-on-mutate]] · [[../tables/director_activity]] · [[spec-card-state]] (the source of truth this library writes to) · [[../recipes/build-box-setup]]
