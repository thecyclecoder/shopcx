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

> **⚠️ A fail-closed gate needs a way to CLEAR and a way to SHOUT.** Three legs failing closed is right individually, but the *composition* had neither. The 2026-08-11 incident — half a day of ticket-derived fix specs stuck, PRs green + mergeable + unpromotable — was two fail-closed gates with no escape: a `real-vuln` verdict nothing could supersede (row 6b), and a `predeploy:static` park with zero repair passes that stopped the very fix specs that would have cleared it. Each was individually defensible; together they were a deadlock, and it was **silent**. When you add a fail-closed gate, ship the path that clears it and the card that says it's stuck ([[../libraries/agent-jobs]] `escalateStalledPromoteEligibility`).

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
| 6b | **`real-vuln` on an UNMERGED branch → was a PERMANENT deadlock** (fixed) | branch `security-review` row `status='completed'` + `instructions.verdict='real-vuln'`; `isSpecPromoteEligible` → `securityGreen:false`, `reason:"security not green on branch"` while accumulation + spec-test are BOTH green; PR open indefinitely; **zero `kind='fix'` phases created since 2026-07-20** | **Root cause: the fixes-as-phases wiring was deleted.** `610790798` (2026-07-17, "remove dead Vera code") removed `buildSecurityFailingChecks`'s only caller during the Vera un-fusion, orphaning it — so every pre-merge finding fell back to the RETIRED standalone fix-spec model, which lands on its OWN branch and therefore can never advance the origin's, so dedup (2) never re-reviews and the verdict is permanent. **Restored:** a branch-mode `real-vuln` appends a `sec:`-keyed `kind='fix'` phase to the ORIGIN via `spawnPreMergeFix` and rebuilds on the origin's branch — that push earns the fresh review naturally. Guarded by `npm run check:security-fix-phase-wiring`. `isSpecPromoteEligible(ws, slug, branch)` to inspect |
| 6c | **promote-eligibility never opens (any leg) — now LOUD** | a CEO card with `metadata.escalation_kind='promote_stall'` naming the failing leg, raised once per spec after 6h | [[../libraries/agent-jobs]] `escalateStalledPromoteEligibility` (runs in the platform-director standing pass; detector only, never merges) |
| 7 | **chained-phase never advanced** | a `planned` phase but no build job with its scoped instructions — `queueNextChainedPhase` returned null (in-flight ACTIVE_STATUSES / goal-mate admission / every reachable phase already carries a matching build job — see 7b for the missed-stamp form) | `whyIsSpecNotBuilding(slug)` → `reason:"no_build_job"` |
| 7b | **built-not-stamped-then-stranded** *(the missed-stamp trap)* | a `planned` phase whose stamp DID NOT land — `build_sha=null` — but a `completed` build job for it exists carrying `phaseScopedInstructions(title)` byte-for-byte. Before the [[../specs/unstamped-phase-cannot-silently-strand-a-build]] fix this wedged the chain permanently (the OLD `queueNextChainedPhase` picked the phase and bailed on its own dedup); now `queueNextChainedPhase` skips forward via `selectNextUnbuiltPlannedPhase` and `[chain-advance] {slug}: skipping planned phase #N …` is logged. The board detector `built-not-stamped` ([[../libraries/pipeline-doctor]]) surfaces the same condition at HIGH severity — its status guard admits `planned` (see the trace below) | `investigateSpec(slug).diagnosis.detectors` → look for `built-not-stamped`; log grep `[chain-advance]` for the skip line |
| 8 | **goal-member serialized** | a queued build held because a goal-mate is in-flight; future `claimed_at` cooldown | `whyIsSpecNotBuilding` → `reason:"goal_member_serialized"` |
| 9 | **blocked_by DAG** | uncleared `blocked_by` slug → no build job ever enqueued | `whatIsSpecWaitingOn` → `kind:"blocked_by"` |
| 10 | **goal accumulation / atomic promote** | every member has `goal_branch_sha`; `goals.main_merge_sha` set on the atomic merge; `promotion_held_reason` on conflict | `investigateGoal(goalSlug)` → `{accumulation, members}` |
| 11 | **spec accumulation / promote-eligibility** | all phases have `build_sha`; `isSpecPromoteEligible` = accumulation ∧ spec-test-green ∧ security-green | `investigateGoal().members[].promoteEligible/promoteReason` |
| 12 | **fold** | machine spec-test `approved` → `autoFoldVerifiedSpecs`; `specs.status='folded'` (preserved) | `getSpecTimeline` (`fold_started`/`folded`); `investigateSpec().folded` |
| 13 | **drift / reconcile** | `healed_built_unstamped` (drift reconciler stamped a built-but-unstamped phase); `spec_status_history` best-effort | `getSpecTimeline` (director_activity + timecard merged) |

## The missed-stamp trap: a cross-module failure no library page owns  *(unstamped-phase-cannot-silently-strand-a-build)*

Two individually-correct pieces of code compose into a silent, indefinite stall. The bug only appears when you hold the phase status derivation and the chain selection in your head at once, which is why this trace lives on the lifecycle page.

**The trace, step by step.**

1. A phase's build session runs to completion on its branch (the commit lands).
2. `stampPhaseBuilt` and the status flip are separate operations. The stamp *does not* land — a rare-but-real DB drift, the same class the `healed_built_unstamped` reconciler exists to repair.
3. That phase keeps deriving `planned` because [[../libraries/specs-table]] `derivePhaseStatus` returns `in_progress` only when `build_sha` is non-null; the whole spec derives `planned` too (rollup).
4. `queueNextChainedPhase` runs on the next reconcile pass. Historically it did a single `find(status === "planned")`, computed `phaseScopedInstructions(title)`, and then a per-phase dedup query returned null because that phase's own scoped build job existed. The chain never advanced — and every LATER phase (notably an appended `kind='fix'` phase from a security or spec-test gate) was permanently unreachable.
5. The board detector `detectBuiltNotStamped` ([[../libraries/pipeline-doctor]]) exists for exactly this case. Its `reason` string names "the build ran yet `stampPhaseBuilt` never advanced any phase" — but its old status guard admitted only `derivedStatus === "in_progress"`, and (from step 3) a missed-stamp spec derives `planned`. **The one alarm for the failure was unreachable in precisely the case it names.**

**The fixes** ([[../specs/unstamped-phase-cannot-silently-strand-a-build]]):

- Phase 1 — the detector's status guard admits the shared `BUILT_NOT_STAMPED_STATUSES` set (`planned` + `in_progress`). Pinned by `npm run test:built-not-stamped`.
- Phase 2 — `queueNextChainedPhase` reads its spec's build-job instructions ONCE and calls the exported pure helper `selectNextUnbuiltPlannedPhase(orderedPlannedTitles, existingInstructions)`, an ordered scan that skips any planned phase whose scoped instruction is already on a build job. On every skip a `console.warn` names the spec slug + skipped phase position — the log-level surface for the same condition the board detector alarms on. Pinned by `npm run test:chain-advance-skip`.

**Ground-truth incident.** The `card-removal-fix` spec sat **seventeen hours** with an open, mergeable, CI-green pull request carrying an unfixed **real credential leak** surfaced by a security review. Its 2026-08-16 20:38 build job carried `phaseScopedInstructions('P1 — implement the fix')` byte-for-byte while P1's `build_sha` was `null`, so the appended security fix phase at position 2 was never considered. The director activity log reported that the build had "resumed"; nothing had. The board showed the spec as ordinary planned work. Neither surface said anything was wrong, because the one detector for the failure could not fire.

**Why `auto_build` is not part of this failure.** `queueNextChainedPhase` intentionally overrides [[../libraries/agent-jobs]] `enqueueBuildIfDue` (`intentional override of enqueueBuildIfDue (bo-reactive-gated-build-enqueue Phase 1)`) and therefore does not read `specs.auto_build`. But an `auto_build=false` spec ALSO has no periodic sweep to recover it, which is what left the card-removal spec with no backstop when the chain silently stopped. That distinction is the trap that made the incident hard to diagnose.

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
