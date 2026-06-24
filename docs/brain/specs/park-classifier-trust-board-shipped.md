# Park classifier: trust the board when status='shipped'

**Status:** ⏳ Planned
**Owner:** [[../functions/platform]] · **Parent:** addendum to [[no-parked-specs-auto-route-needs-attention]] Phase 0
**Blocked-by:** —

## Problem

The park classifier introduced by [[no-parked-specs-auto-route-needs-attention]] Phase 0 stamps `agent_jobs.needs_attention_class` based on the build's verdict string + a 1-shot Sonnet pass. Working theory at the time: the verdict text is enough to tell `already_shipped` from `real_blocker`.

In practice, when a `build` job runs and the spec is *already* fully shipped on the board, the worker emits verdicts like 'Phase 1 was already built end-to-end in #315' or 'this was a self-watch gate-lift, not a feature delta'. The classifier doesn't recognize those phrasings and falls back to `class='unknown'`. The `unknown` rows then never reach Phase 1 (auto-fold), so they sit in `needs_attention` until the Phase 4 60-minute backstop sweep wakes up — and even then the backstop routes them to a director investigation, not an auto-fold.

Found 2026-06-24: 5 parks stuck in this state — `agent-outage-resilience`, `director-loop-grading`, `regression-backlog-reconciliation`, `experiment-session-stamped-attribution`, `goal-milestone-build-sequencing`. Every one has `spec_card_state.status='shipped'` with every phase shipped. The board is correct; the park row is queue noise.

## Insight

The board is the source of truth on whether a spec is shipped. If `spec_card_state.status='shipped'`, a `build` job parked against that spec is by definition `already_shipped` — regardless of the build's verdict string or the Sonnet classifier's confidence. The classifier doesn't need to read the verdict to know that.

## Phases

### Phase 1 — classifier looks at the board first

- In `src/lib/agents/park-classifier.ts` (or wherever Phase 0 lives — confirm path during build), before the verdict-string heuristic and the Sonnet pass: if `agent_jobs.kind='build'` and `spec_card_state.status='shipped'` for the same `spec_slug`/`workspace_id`, stamp `needs_attention_class='already_shipped'` and skip the rest of the classification pipeline.
- Same short-circuit for `agent_jobs.kind` in any other build-style kind that targets a spec (`regression`, `repair`) — confirm the list against [[../tables/agent_jobs]] kinds.
- Add the rule to the classifier's unit test fixture: a parked build with `spec_card_state.status='shipped'` must classify as `already_shipped`, even with a verdict string the heuristic doesn't recognize.

### Phase 2 — one-shot reclassification of the stuck rows

- A one-off `scripts/_reclassify-stuck-shipped-parks.ts` (read-only by default, `--apply` flag) that finds every `agent_jobs` row where `status='needs_attention'`, `needs_attention_class IN ('unknown', NULL)`, and the matching `spec_card_state.status='shipped'`, and re-stamps `needs_attention_class='already_shipped'`.
- The existing Phase 1 auto-fold cron picks them up within 10 min and dismisses them.
- Run once; not a recurring script.

## Verification

- The 5 stuck rows listed above flip to `class='already_shipped'` within minutes of Phase 2 running, then auto-dismiss via the Phase 1 cron in [[no-parked-specs-auto-route-needs-attention]].
- Future `build` parks against already-shipped specs never reach `class='unknown'` — they hit the short-circuit in Phase 1.
- `agent_jobs` rows with `status='needs_attention'` AND `class='unknown'` AND matching `spec_card_state.status='shipped'` = 0 (alarm asserts this).
