# Lifecycle: the spec build pipeline (and how to investigate every state)

The single map of a spec's life from authored → folded, **and the state → failure-mode → investigation-entry-point index**. When someone asks "why did spec X fail spec-review?" / "what is X waiting on?" / "why isn't X building?", this page + the [[../libraries/spec-investigation]] SDK answer it in one call instead of a 10-minute dig across nine modules.

- **Mechanics (deep trace):** [[spec-goal-branch-pm-flow]] — author → branch-accumulated phases → preview spec-test/security → atomic promote/fold.
- **Console / dispatch + build-outcome states:** [[roadmap-build-console]].
- **Automated stall detection over this lifecycle:** [[mario-pipeline-plumbing]] (Mario reacts to timecard outliers).
- **The investigation SDK:** [[../libraries/spec-investigation]] — the read-only front door every state below maps to.
- **The human diagnostic tool:** [[../recipes/pipeline-doctor]] (`diagnosePipeline` / `scripts/pipeline-status.ts`).

## The state machine

```
IDEA(memory) → PLANNED → IN_TESTING → SHIPPED → FOLDED
```

authored → `in_review` → Vale (`pass`｜`needs_fix`) → Ada disposition (`same`｜`downgrade`｜`upgrade`-CEO-gated) → build (phases accumulate on `claude/build-{slug}`) → accumulation-complete → preview → pre-merge spec-test + security → `in_testing` → promote (Gate A one-off｜Gate B→C goal) → `shipped` → machine spec-test `approved` → `folded`.

**Derived vs stored (the central invariant).** `specs.status` is OVERRIDE-ONLY — it stores only `deferred`｜`folded`｜`NULL`. Everything else (`planned`｜`in_progress`｜`in_testing`｜`shipped`｜`in_review`) is DERIVED at read time by `deriveSpecCardStatus` from the phase rollup. A built spec can never read `in_review`. See [[../tables/specs]], [[../libraries/brain-roadmap]].

### The enums (ground truth)

| Variable | Values |
|---|---|
| `specs.status` (stored, override-only) | `NULL` ｜ `deferred` ｜ `folded` |
| Derived `SpecStatus` | `planned ｜ in_progress ｜ in_testing ｜ shipped ｜ rejected ｜ deferred ｜ in_review` |
| `spec_phases.status` | `planned ｜ in_progress ｜ shipped ｜ rejected` |
| `spec_phases.kind` | `phase ｜ fix` |
| `agent_jobs.status` | `queued ｜ claimed ｜ building ｜ completed ｜ needs_input ｜ needs_approval ｜ queued_resume ｜ blocked_on_usage ｜ held ｜ dismissed ｜ failed ｜ needs_attention ｜ merged` |
| `spec_test_runs.agent_verdict` | `approved ｜ issues ｜ needs_human ｜ error` |
| `specs.vale_pass` (tri-state) | `null` (unreviewed) ｜ `true` (passed) ｜ `false` (needs_fix) |
| `goals.status` | `proposed ｜ greenlit ｜ complete ｜ folded` |

**Fail-open vs fail-closed:** accumulation fails OPEN (a PM blip won't wedge a green spec); spec-test-green and security-green fail CLOSED (an absent run is NOT green).

## State → failure mode → how to investigate

Every row's investigation entry point is a [[../libraries/spec-investigation]] call (fast, slug-scoped) and/or the underlying columns.

| # | State / failure | What it looks like in the DB | Investigate with |
|---|---|---|---|
| 1 | **spec-review `needs_fix`** | `vale_pass=false`, `vale_review_passed_at IS NULL`; reasoning in a `director_activity` `spec_review_needs_fix` row | `whyDidSpecReviewFail(slug)` → `{valePass, needsFixReason, defects}` |
| 1b | **passed-but-unstamped** (legacy-disposition bug) | `vale_pass=true` yet `vale_review_passed_at IS NULL` → build claim-gate holds it forever | `whyDidSpecReviewFail` → `verdict:"passed_but_unstamped"` |
| 2 | **re-enqueue for review** | `markSpecCardBackToReview` NULLs `vale_pass`+`vale_review_passed_at`; a changed re-author reopens | timeline: `spec_sent_back_to_review` in `getSpecTimeline` |
| 3 | **build parked** | `agent_jobs.status ∈ {needs_input, needs_approval, needs_attention, blocked_on_usage, held, dismissed}` + `needs_attention_class` | `whatIsSpecWaitingOn(slug)` → `{kind, prompts, waitingOn, sinceMs}` |
| 4 | **spec-test `issues` → fix phase** | latest `spec_test_runs.agent_verdict='issues'` w/ `checks[].verdict='fail'`; a `spec_phases.kind='fix'` row appended (`origin_check_keys`); `queueNextChainedPhase` resumes the build | `investigateFixPhases(slug)` + `investigateSpec().diagnosis.specTest` |
| 4b | **fix loop-guard / depth-guard** | `PRE_MERGE_FIX_LOOP_GUARD_MAX=2` fix phases already → `director_activity` `escalated` | timeline: `escalated` (signature `fixes-as-phases-loop-guard`) |
| 5 | **spec-test `needs_human`/`error`/`inconclusive`** | not green → not promote-eligible (fails closed) | `investigateSpec().diagnosis.specTest` |
| 6 | **security finding / `real-vuln`** | security-review job `surfaced`; a routed fix spec or fixes-as-phases (`check_key='sec:…'`) | `investigateSpec().diagnosis.security` |
| 7 | **chained-phase never advanced** | a `planned` phase but no build job with its scoped instructions — `queueNextChainedPhase` returned null (dedup / in-flight ACTIVE_STATUSES / resume-candidate) | `whyIsSpecNotBuilding(slug)` → `reason:"no_build_job"` |
| 8 | **goal-member serialized** | a queued build held because a goal-mate is in-flight; future `claimed_at` cooldown | `whyIsSpecNotBuilding` → `reason:"goal_member_serialized"` |
| 9 | **blocked_by DAG** | uncleared `blocked_by` slug → no build job ever enqueued | `whatIsSpecWaitingOn` → `kind:"blocked_by"` |
| 10 | **goal accumulation / atomic promote** | every member has `goal_branch_sha`; `goals.main_merge_sha` set on the atomic merge; `promotion_held_reason` on conflict | `investigateGoal(goalSlug)` → `{accumulation, members}` |
| 11 | **spec accumulation / promote-eligibility** | all phases have `build_sha`; `isSpecPromoteEligible` = accumulation ∧ spec-test-green ∧ security-green | `investigateGoal().members[].promoteEligible/promoteReason` |
| 12 | **fold** | machine spec-test `approved` → `autoFoldVerifiedSpecs`; `specs.status='folded'` (preserved) | `getSpecTimeline` (`fold_started`/`folded`); `investigateSpec().folded` |
| 13 | **drift / reconcile** | `healed_built_unstamped` (drift reconciler stamped a built-but-unstamped phase); `spec_status_history` best-effort | `getSpecTimeline` (director_activity + timecard merged) |

## The investigation SDK (front door)

`src/lib/spec-investigation.ts` ([[../libraries/spec-investigation]]) — **read-only**, composes the existing readers (never re-derives status), fills the five gaps that had no public reader (Vale needs_fix reasoning, a `director_activity` timeline, a goal accumulation/promotion projection, the timecard↔doctor bridge, a needs_input/needs_approval investigator), and is slug-scoped for speed (the per-spec calls avoid the whole-workspace fan-out via `diagnoseSpec`).

- `investigateSpec(slug)` — the everything call (diagnosis + review + waiting + fixPhases + timecard + timeline + goal). Degrades for folded specs (retrospective).
- `whyDidSpecReviewFail(slug)` · `whatIsSpecWaitingOn(slug)` · `whyIsSpecNotBuilding(slug)` — the fast, question-shaped answers.
- `investigateGoal(goalSlug)` — accumulation + per-member promote-eligibility + stuck state.
- `investigateFixPhases(slug)` · `getSpecTimeline(slug)` — targeted readers.

## Status / open work

- ✅ **Spec submission hardened at the writer (harden-spec-submission hotfix).** [[../libraries/specs-table]] `upsertSpec` now SELF-GATES: it throws `UngatedSpecAuthorError` before any write if a phase's effective `verification` is empty, the spec's effective `why`/`what` is empty, or there are zero phases — so a raw bypass of the [[../libraries/author-spec]] gates can no longer land an untestable spec (the failure mode behind the 4 verification-NULL specs of 2026-07-10). `submitSpec` is the new canonical alias for `authorSpecRowStructured`. Mario gained a 4th detector source (`readReviewFailedVerificationStalls`) that auto-repairs review-failed / missing-verification specs (the pre-guard stragglers) through the existing `verification_repair` verb — see [[mario-pipeline-plumbing]] / [[../libraries/mario]].
- ✅ SDK live (`spec-investigation.ts`), slug-scoped single-spec path (`pipeline-doctor.diagnoseSpec` + `getLaneOccupancy`), slug-scoped `security-agent.getSecurityStateForSlug`.
- ⏳ Mario's box session investigates through this SDK ([[mario-pipeline-plumbing]]).
- ⏳ Known outstanding pipeline bugs (tracked): timecard backfill seeds events for slugs with no `public.specs` row; the stall detector's phantom guard (`mario.ts`); Mario's fix-spec author-write silently failing.
