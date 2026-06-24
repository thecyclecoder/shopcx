# Park classifier: trust the board when status='shipped' ✅

**Status:** ✅ Shipped
**Owner:** [[../functions/platform]] · **Parent:** addendum to [[no-parked-specs-auto-route-needs-attention]] Phase 0
**Blocked-by:** —

## Problem

The park classifier introduced by [[no-parked-specs-auto-route-needs-attention]] Phase 0 stamps `agent_jobs.needs_attention_class` based on the build's verdict string + a 1-shot Sonnet pass. Working theory at the time: the verdict text is enough to tell `already_shipped` from `real_blocker`.

In practice, when a `build` job runs and the spec is *already* fully shipped on the board, the worker emits verdicts like 'Phase 1 was already built end-to-end in #315' or 'this was a self-watch gate-lift, not a feature delta'. The classifier doesn't recognize those phrasings and falls back to `class='unknown'`. The `unknown` rows then never reach Phase 1 (auto-fold), so they sit in `needs_attention` until the Phase 4 60-minute backstop sweep wakes up — and even then the backstop routes them to a director investigation, not an auto-fold.

Found 2026-06-24: 5 parks stuck in this state — `agent-outage-resilience`, `director-loop-grading`, `regression-backlog-reconciliation`, `experiment-session-stamped-attribution`, `goal-milestone-build-sequencing`. Every one has `spec_card_state.status='shipped'` with every phase shipped. The board is correct; the park row is queue noise.

## Insight

The board is the source of truth on whether a spec is shipped. If `spec_card_state.status='shipped'`, a `build` job parked against that spec is by definition `already_shipped` — regardless of the build's verdict string or the Sonnet classifier's confidence. The classifier doesn't need to read the verdict to know that.

## Phases

### Phase 1 — classifier looks at the board first ✅

- ✅ Phase 0 lives in `src/lib/agents/needs-attention-classify.ts` (the spec's `park-classifier.ts` placeholder name — `needs-attention-classify` is the real module).
- ✅ Added `classifyByBoardState(input)` — a pure decision helper that returns `already_shipped` when `BUILD_STYLE_KINDS.has(jobKind)` AND `input.boardStatus === 'shipped'` AND `input.specSlug` is present.
- ✅ `BUILD_STYLE_KINDS = {build, regression, repair}` — the spec-targeted kinds confirmed against [[../tables/agent_jobs]].
- ✅ `classifyNeedsAttention` runs `classifyByBoardState` BEFORE the verdict-string heuristic + the Sonnet pass — board verdict wins.
- ✅ `classifyAndStamp` resolves the live board status from `spec_card_state` via `lookupBoardStatus(admin, workspaceId, specSlug)` and passes `boardStatus` through to the pure classifier (best-effort: a board lookup failure falls back to heuristic + Sonnet, never blocks classification).
- ✅ Unit test fixture `src/lib/agents/needs-attention-classify.test.ts`: a `build` with `boardStatus='shipped'` and an error string the heuristic explicitly does NOT match still classifies as `already_shipped`. Also covers `regression`/`repair` short-circuit, non-build-style kinds skipping the rule, and non-shipped board statuses skipping the rule.

### Phase 2 — one-shot reclassification of the stuck rows ✅

- ✅ `scripts/reclassify-stuck-shipped-parks.ts` — read-only by default, `--apply` flag. (Filename drops the `_` prefix on purpose: `scripts/_*` is gitignored, and the worker has to run this through the gated-actions flow against a re-checked-out tree, so the file must be tracked.)
- ✅ Selects `agent_jobs` where `status='needs_attention'`, `needs_attention_class IS NULL OR ='unknown'`, joins `spec_card_state` by `(workspace_id, spec_slug)`, keeps only rows where the card's `status='shipped'`, and on `--apply` re-stamps `needs_attention_class='already_shipped'`.
- ✅ The Phase 1 auto-fold cron in [[no-parked-specs-auto-route-needs-attention]] picks them up within ~10 min and dismisses them.
- ✅ One-off — not a recurring script. **Awaiting prod approval to run** (the build box has no prod creds — the worker emits the apply action for one-tap owner approval).

## Verification

- On the build box, run `npx tsx --test src/lib/agents/needs-attention-classify.test.ts` → expect every assertion green (board-first short-circuit fires for build/regression/repair; skips for plan/fold/spec-test; skips for non-shipped statuses).
- On the build box, run `npx tsx scripts/reclassify-stuck-shipped-parks.ts` (no `--apply`) → expect a dry-run log listing the stuck rows (≥ the 5 found 2026-06-24: `agent-outage-resilience`, `director-loop-grading`, `regression-backlog-reconciliation`, `experiment-session-stamped-attribution`, `goal-milestone-build-sequencing`) without any DB writes.
- After running the script with `--apply` (one-tap owner approval — the build box has no prod creds), query Supabase `select count(*) from agent_jobs where status='needs_attention' and (needs_attention_class is null or needs_attention_class='unknown') and spec_slug in (...)` → expect `0` within ~1 min.
- On `/dashboard/developer/control-tower` (or wherever the needs_attention queue surfaces), the 5 listed parks → expect them gone within ~10 min of `--apply` (auto-folded by the Phase 1 cron in [[no-parked-specs-auto-route-needs-attention]]).
- Inspect `src/lib/agents/needs-attention-classify.ts` → expect `classifyByBoardState` to be invoked **before** `classifyByHeuristic` inside `classifyNeedsAttention` (the call order is what guarantees the board verdict wins).
- Going forward, query `select count(*) from agent_jobs aj join spec_card_state s on s.workspace_id=aj.workspace_id and s.spec_slug=aj.spec_slug where aj.status='needs_attention' and aj.needs_attention_class='unknown' and s.status='shipped'` → expect `0` (the standing invariant; the alarm in [[no-parked-specs-auto-route-needs-attention]] can assert this).
