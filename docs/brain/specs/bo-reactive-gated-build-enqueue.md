# bo-reactive-gated-build-enqueue

**Owner:** [[../functions/platform]]
**Parent:** [[../functions/platform]] — Autonomous build platform mandate.

The build lane's leg of the [[../operational-rules#PM-agent activation contract|PM-agent activation contract]] — every `kind='build'` enqueue routes through one gated chokepoint (`enqueueBuildIfDue`) so an unblocked-but-un-Vale-passed dependent no longer gets a premature `queued` build row (the CEO-visible symptom this spec retires), and a reactive fire on an already-satisfied target no-ops for free.

## Phases

### Phase 1 — gated chokepoint
- Add `enqueueBuildIfDue(workspaceId, slug)` to `src/lib/agent-jobs.ts` as the single gated chokepoint for `kind='build'` enqueues: one cheap `getSpec` read + eligibility gate mirroring Ada's `isBuildableSpec` (`specReviewDone` via `card.valeReviewPassed` / not-shipped / not-deferred / `auto_build !== false` / all `blocked_by` cleared) + one-in-flight guard, returning distinct reasons (`spec-not-found | already-shipped | deferred | not-review-passed | auto-build-off | blocked | in-flight`).
- Route `autoQueueUnblockedBy` (the reactive un-gated site) through `enqueueBuildIfDue` instead of its raw `.insert`, so an unblocked-but-un-Vale-passed dependent no longer gets a premature `queued` build row.
- Mark the remaining sanctioned raw-insert sites (`pre-merge-fix.ts`, `needs-attention-route.ts`, `director-directives.ts` `enqueuePriorityBuild`, `queueNextChainedPhase` in `agent-jobs.ts`) with `// intentional override:` comments explaining why each bypasses the review gate.

### Phase 2 — reactive fire
- Add `src/lib/inngest/build-on-eligible.ts` (event: `build/spec-build-eligible`, concurrency by workspace, body calls `enqueueBuildIfDue`).
- Register `buildOnEligible` in `src/lib/inngest/registered-functions.ts`.
- Fire the fire-and-forget event from `markSpecCardValePassed` and `applyAdaDisposition('planned')` in `src/lib/spec-card-state.ts` (untyped `@/lib/inngest/client`, `.catch(()=>{})`), so the reactive path fires on the transition instead of waiting for the `*/5` platform-director cron.
- The `*/5` platform-director cron remains the gated backstop; `enqueueBuildIfDue`'s one-in-flight guard makes any cron/event race a clean no-op.

## Verification
- Every `kind='build'` enqueue in `src/lib/**` and `scripts/builder-worker.ts` routes through `enqueueBuildIfDue` (or carries an `// intentional override:` comment naming its reason).
- `enqueueBuildIfDue` returns a distinct legible reason for each gate miss so heartbeat logs distinguish nothing-due from in-flight.
- The reactive `build/spec-build-eligible` event fires on `markSpecCardValePassed` + `applyAdaDisposition('planned')` and its Inngest consumer calls `enqueueBuildIfDue` for the workspace/slug.
- The platform-director `*/5` cron continues to backstop the same gate; a burst of races between reactive fire + cron + standing pass results in exactly one queued build (or a legible no-op reason).
