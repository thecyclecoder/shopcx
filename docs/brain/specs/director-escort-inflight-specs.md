# Director escort — drive in-flight + authored-fix specs through to ship

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — closes the gap where the director authors a fix-spec, queues a build, and forgets to follow up. Specs sit `in_progress` for hours when a minimal escort would have shipped them. Authored from context to match the existing `spec_card_state` row (the markdown step never ran the first time).
**Blocked-by:** —

A director's existing standing pass investigates parks, grooms new specs, lifts gated builds, etc. — but it does NOT actively drive **specs the director itself authored** through to ship. The result is a class of stalls only the director can fix: a build that errored out, a spec stuck `in_progress` with no `agent_jobs` row in flight, a critical spec the CEO marked but no one rebuilt. This spec adds an explicit escort pass at the START of every standing run.

## Phase 1 — sweep + drive in-flight + authored-fix specs
- New step at the START of every standing pass (before grooming + classifier): `escortSweep()` in `src/lib/agents/platform-director.ts`.
- Pull every `spec_card_state` row in this director's owner scope where `status='in_progress'` OR (`status='planned'` AND `flags.critical=true`) OR the spec was authored by this director within the last 7 days (`director_activity` `kind='specced'`).
- For each: look up the latest `agent_jobs` row for `spec_slug={slug}` `kind='build'`. Five lanes:
  1. No build job ever → enqueue a build + log `escort_queued_build`.
  2. Build job `status='completed'` but spec still planned/in_progress → log `escort_status_drift` + flip phases (owner-scoped via spec-status; non-owned slugs escalate).
  3. Build job `status='failed'` 1× → enqueue a retry.
  4. Build job `status='failed'` ≥2× → re-investigate via the groom lane (propose fix-spec or dismiss-candidate using [[director-judgment-lanes-fold-author-dismiss]]).
  5. Build job `status='queued' OR 'running'` for >2h with no merge_sha → mark `escort_stalled` + investigate (parked? missing dep? branch-stuck?).
- Every action stamps a `director_activity` row `kind='escorted'` with the slug + the lane it took + a one-line reason.
- Loop-guard: if `escortSweep` ran the SAME action on the SAME slug ≥3× in 24h, escalate instead of re-acting (prevents an infinite re-enqueue on a build that always fails the same way).

## Verification
- After Phase 1 ships: trigger one director pass with a stale `in_progress` spec in fixtures → confirm a `director_activity` `kind='escorted'` row + a new `agent_jobs` build row land.
- Confirm the loop-guard fires on a synthetic 3×-fail scenario by checking the escalation lane was used.
- `spec_status_history` rows show `actor=director:platform` for any owned status flips.
- `npx tsc --noEmit` clean.
