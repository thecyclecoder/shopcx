# ada-director-spec-status-cards-fix-tooling-fa6848 ✅

**Owner:** [[../functions/platform]]
**Parent:** [[../specs/ada-director-spec-status-cards]]
**Priority:** critical

**Status:** ✅ Shipped

## Why

Auto-authored by Ada (Platform/DevOps Director) from a parked security-review on [[../specs/ada-director-spec-status-cards]] (job fa6848a7, class `tooling_failure`).

The build of [[../specs/ada-director-spec-status-cards]] parked because the agent itself failed to produce a verdict (the security-review pipeline's tooling, not the origin's content). Fix the tool so the origin's build can run cleanly.

### Evidence

```
Park reason: security review produced no parseable verdict after 2 attempts — re-run or review manually: nputTokens":41878,"webSearchRequests":0,"costUSD":0.7348914999999999,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"c96
Log tail: putTokens":41878,"webSearchRequests":0,"costUSD":0.7348914999999999,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"c963efe6-c592-45a0-982a-4da92318acb0"}
Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.
```

## Phases

### Phase 1 — diagnose + fix ✅

- ✅ **Traced the failure.** The shared `resolveReviewVerdict` helper in `scripts/builder-worker.ts` ran the security-review investigation twice with the **same prompt** on parse failure (no signal that "your previous output was unparseable"), and the shared `extractJson` used a **greedy first-`{` to last-`}` span** that breaks when the agent emits prose-with-braces around the verdict envelope (or when the result text contains a JSON-shaped excerpt from the diff being reviewed). The agent's first attempt produced a `result` field whose verdict envelope was unparseable under that strategy, and the blind re-run reproduced the same shape — both attempts failed, the actionable fail-safe fired ("…produced no parseable verdict after 2 attempts…"), and the director's `reconcileNeedsAttention` auto-routed the parked item to this fix spec.
- ✅ **Authored the minimum fix** (two strictly-additive changes, mirroring the proven [[../specs/spec-test-json-robustness]] pattern):
  1. **`extractJson` hardening** (`scripts/builder-worker.ts`): keep the whole-text + greedy strategies, ADD (a) last-fenced ```` ```json ```` block (last-wins, picks the verdict envelope past earlier example fences) and (b) a right-to-left LAST balanced `{…}` walk (close-braces from the end × open-braces from the start). Strictly additive — finds more valid JSONs, never fewer.
  2. **Retry-aware runner contract** in `resolveReviewVerdict`: the retry now passes a `RetryReason` (last excerpt + previous session id) to the runner so it can append a JSON-only repair hint to its prompt. The new `reviewVerdictRetryHint()` builds that hint — names the exact recognized vocabulary, demands ONLY the verdict envelope as the final message, and tells the agent that "needs-human" is always valid if it cannot classify with confidence (so a second attempt never silently no-verdicts). All three callers (security-review, repair, regression-review) now thread `(_attempt, retry) => …prompt + (retry ? reviewVerdictRetryHint(…) : "")` through the shared helper.
- ✅ **Verified.** `npx tsc --noEmit` clean. The next security-review pass on the origin [[../specs/ada-director-spec-status-cards]] (re-queued by the director's `reconcileNeedsAttention` once this fix lands) will benefit from the harder extractor on attempt 1 and the JSON-only nudge on attempt 2 — see `## Verification` below for the prod-facing checklist.

## Verification

- Open `scripts/builder-worker.ts` and read `extractJson` → expect: (a) the existing whole-text + greedy `first { … last }` paths are still there, (b) a new last-wins fenced ```` ```json ```` loop using `matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)`, and (c) a right-to-left balanced-object walk (close-brace indices from the end × open-brace indices from the start) that returns the first balanced `text.slice(start, end + 1)` that parses to a non-null object.
- In `scripts/builder-worker.ts`, read `resolveReviewVerdict` → expect the `run` callback signature is `(attempt: number, retry: RetryReason | null) => Promise<T>`, the loop seeds `retry = null` on attempt 1, and after a failed parse it sets `retry = { lastExcerpt: r.raw.trim().slice(-400), prevSession: r.session ?? null }` before the next iteration.
- In the same file, read `reviewVerdictRetryHint(agent, vocabulary, retry)` → expect the returned string names the agent ("security review" | "repair" | "regression review"), lists the recognized status vocabulary, demands ONLY one JSON object as the final message, says "needs-human" is always valid as a safe terminal verdict, and includes the previous attempt's tail (last ~280 chars).
- In the same file, read the three call sites (security-review near the `SECURITY_VERDICTS` Set, repair near `REPAIR_VERDICTS`, regression-review near `REGRESSION_VERDICTS`) → expect each `run` closure now takes `(_attempt, retry)` and appends `reviewVerdictRetryHint(…)` to its base prompt only when `retry` is truthy (attempt > 1).
- Run `npx tsc --noEmit` → expect 0 errors.
- After this PR merges, observe the box worker's next security-review pass on the origin [[../specs/ada-director-spec-status-cards]] (the director's `reconcileNeedsAttention` re-queues the parked job once the fix is live) → expect the verdict resolves on attempt 1 (envelope now picked out of any surrounding prose) or attempt 2 (the JSON-only retry hint nudges the agent to deliver the envelope), and the `agent_jobs` row for the security-review job ends `status='completed'` (clean/false-positive) | `status='needs_attention'` with a real verdict like `needs-human` — NOT the `"…produced no parseable verdict after 2 attempts…"` fail-safe.
- Sanity-check the strictly-additive claim against the existing two-attempt fail-safe: an inconclusive agent whose retry STILL produces no verdict envelope must still fall through to the actionable `"<agent> produced no parseable verdict after 2 attempts — re-run or review manually: <excerpt>"` reason (NOT auto-pass) — same path as before, just with the new retry hint applied to the second attempt.
