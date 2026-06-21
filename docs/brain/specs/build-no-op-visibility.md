# Build Console: No Silent No-Op Builds + Report-Issue Enqueue Confirmation ✅ SUPERSEDED

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate — Roadmap build-console reliability (hardens [[../lifecycles/roadmap-build-console]])

> **Superseded by [[../specs/fix-report-issue-dropped]] (merged as #155, 2026-06-21).** That PR landed first and shipped the same functionality, so this spec's branch (`claude/build-no-op-visibility-mqo1sbzo`) became a conflicted near-duplicate and should be abandoned, not merged.

## What #155 already covers
- **Phase 1 — no-op build surfaces as `needs_attention`:** #155 added the `no_changes_reason` field to `parseStatus`, updated the build-spec prompt contract to require a no-change reason, and flipped the silent `completed`/no-PR path in `scripts/builder-worker.ts` (`if (!dirty)` block) to `status='needs_attention'` carrying the agent's stated reason — fixing the 3 phantom PR-less 'completed' builds.
- **Phase 2 — Report-Issue enqueue confirmation:** #155 reworked `BuildButton.tsx` reportIssue() and the Slack path so a submit only reads as queued when the server returns the created job (handles `queuedBehindActive` and the `alreadyActive` coalesce), and surfaces an error on failure — a richer version of this spec's notice banner.

## Residual delta (not shipped — optional)
- This branch additionally split the no-change case with an explicit `git rev-list --count origin/main..HEAD`: 0-commits-clean-tree → `needs_attention` vs commits-exist-but-PR-creation-failed → `needs_attention`. #155 reaches equivalent outcomes via the PR-existence check, so this is a marginal refinement. Open a small focused spec only if the more granular signal is wanted.
- Phase 3 (scope guard: pause vague Report-Issues on `needs_input` instead of no-op) was NOT implemented by either PR. If still desired, carry it into a fresh narrow spec.

## Action
- Abandon `claude/build-no-op-visibility-mqo1sbzo` and close its PR. Do not conflict-resolve+merge.
- Fold this note's residual items into [[../lifecycles/roadmap-build-console]] if pursuing, then delete this spec file.