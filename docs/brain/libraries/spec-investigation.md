# library: `src/lib/spec-investigation.ts`

The unified, **read-only** investigation SDK for the build pipeline — the single front door for "why did spec X fail spec-review / what is X waiting on / why isn't X building." It COMPOSES the existing readers (never re-derives status — [[brain-roadmap]] / [[pipeline-doctor]] stay authoritative) and fills the five gaps that had no public reader. Primary consumer: Mario ([[mario-pipeline-plumbing]]). Full state→entry-point map: [[../lifecycles/spec-build-pipeline]].

## Why it exists

Answering a pipeline question meant a 10-minute dig across nine modules (raw rows in [[specs-table]], the derived board in [[brain-roadmap]], [[spec-test-runs]], [[security-agent]], [[agent-jobs]], [[spec-timecards]], `director_activity`, [[goals-table]], [[pipeline-doctor]]). This SDK is the one call. The gaps it closes:

1. **Vale's `needs_fix` reasoning** — was private in [[brain-roadmap]] behind the `roadmap_latest_needs_fix_reasons` RPC; now read directly from the latest `spec_review_needs_fix` `director_activity` row.
2. **A `director_activity` timeline** — `director-activity.ts` exports zero readers; every consumer re-queried ad-hoc.
3. **A goal accumulation / atomic-promotion projection** — the logic lived inside the promote WRITER.
4. **The timecard ledger ↔ pipeline-doctor bridge** — two disjoint views of the same spec, now merged in `getSpecTimeline`.
5. **A first-class `needs_input` / `needs_approval` investigator** — who it's waiting on, for how long.

## Performance (no wasteful fan-out)

The per-spec calls are slug-scoped. `investigateSpec` / `whyIsSpecNotBuilding` go through [[pipeline-doctor]] `diagnoseSpec(workspaceId, slug)` — the slug-scoped sibling of `diagnosePipeline` that reuses the SAME `assembleSpec` + classifier registry but reads ONLY this slug's jobs / spec-test / security (the board path pulls ALL and filters). Lane occupancy is a COUNT-only read (`getLaneOccupancy`). Blocker CLEARANCE (the workspace-wide `getSpecBlockers` read) is resolved ONLY when the raw `blocked_by` array is non-empty and the spec is live — a folded/unblocked spec pays nothing. Security is slug-scoped via [[security-agent]] `getSecurityStateForSlug`.

## Exports

| Function | Returns | Use |
|---|---|---|
| `investigateSpec(workspaceId, slug)` | `SpecInvestigation ｜ null` | the everything call: diagnosis + review + waiting + fixPhases + timecard + timeline + goal + headline. Degrades for folded specs (`folded:true`, `diagnosis:null`). Null only for a true phantom (no row at all). |
| `whyDidSpecReviewFail(workspaceId, slug)` | `ReviewState` | Vale tri-state + `needs_fix` reason + defects; flags the passed-but-unstamped legacy bug |
| `whatIsSpecWaitingOn(workspaceId, slug)` | `WaitingState` | needs_input / needs_approval / blocked_by / serialization / usage-cap — with prompts, `waitingOn`, `sinceMs` |
| `whyIsSpecNotBuilding(workspaceId, slug)` | `NotBuildingReason` | ranked single reason: blocked_by / not_review_passed / goal_member_serialized / parked / usage_cap / no_build_job / lane_saturated / shipped / folded / deferred |
| `investigateGoal(workspaceId, goalSlug)` | `GoalInvestigation ｜ null` | accumulation state + per-member status/onGoalBranch/promoteEligible/stuck (slug-scoped per member, never a full scan) |
| `investigateFixPhases(workspaceId, slug)` | `FixPhaseInfo[]` | the `kind='fix'` phases + their `origin_check_keys` + built/shipped state |
| `getSpecTimeline(workspaceId, slug, limit?)` | `TimelineEvent[]` | merged director_activity + timecard chronology ("what happened to this spec") |
| `getGoalContext(workspaceId, goalSlug)` | `GoalContext ｜ null` | goal accumulation + `main_merge_sha` + `promotion_held_reason` projection |

## Read-only invariant

No writer is imported. Actions (re-enqueue for review, re-drive a chained phase) stay in their sanctioned writers ([[spec-card-state]] `markSpecCardBackToReview`, [[agent-jobs]] `queueNextChainedPhase`); this SDK only tells you WHAT is wrong.

## Related

[[../lifecycles/spec-build-pipeline]] · [[pipeline-doctor]] · [[spec-timecards]] · [[mario-pipeline-plumbing]] · [[brain-roadmap]] · [[specs-table]] · [[spec-test-runs]] · [[security-agent]] · [[agent-jobs]] · [[goals-table]]
