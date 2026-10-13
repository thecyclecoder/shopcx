# libraries/security-stale-resume

Pure detector for the **stale-resume failure mode** in security-review verdict parsing — when a Max session resumes with no prior findings in context and incorrectly surfaces a `needs-human` verdict. Phase 5 (Fix 1) of [[../specs/inflection-resession-must-act-on-newest-ask]].

**File:** `src/lib/security-stale-resume.ts` · **Tests:** `src/lib/security-stale-resume.test.ts`

## Why it exists

Ground truth: security-review job 8040a2d9 (build of `inflection-resession-must-act-on-newest-ask`). The pre-merge security review ran attempt 1, produced a session id but no complete verdict (e.g., aborted run, usage-wall mid-pass, reaped resume). Attempt 2 resumed that session to repair the verdict via `securityReviewRepairPrompt` ("reuse the findings you already produced"). But the resumed session had nothing to re-emit from, so the model said "No prior findings available in this session context — a human should re-trigger the review from scratch." That `needs-human` verdict is syntactically valid, so `resolveReviewVerdict` accepted it as authoritative and the build parked with a `real_blocker`-class needs_attention, blocking the merge even though the on-branch code had no security issue.

Phase 5 closes this by detecting the stale-resume signature and discarding the false verdict so the caller falls back to a retry with a fresh session.

## Contract

```ts
function looksLikeStaleResumeAcknowledgement(review: unknown): boolean;

function shouldDiscardStaleResumeVerdict(input: {
  useRepair: boolean;
  verdict: string;
  review: unknown;
  recognized: ReadonlySet<string>;
}): boolean;
```

### `looksLikeStaleResumeAcknowledgement` fires on

Returns `true` iff the review text carries one of these stale-resume signatures:
- "No prior findings available in this session context"
- "the previous security-review run did not carry over"
- "a human should re-trigger the review from scratch"
- "re-run the review from scratch"

Any one phrase is enough — the ground-truth tail (parked job 8040a2d9) contained all three joined by em-dashes. Pure; defensive against null / non-string input.

### `shouldDiscardStaleResumeVerdict` gate

Decides whether to **discard** a parsed verdict (treat it as inconclusive). Only fires under these conditions:
- `useRepair === true` — the verdict came from a REPAIR attempt, not a fresh attempt. A fresh attempt's `needs-human` is a genuine human-needed verdict even if it happens to mention these phrases; only a repair attempt can suffer from stale-resume confusion.
- `verdict === 'needs-human'` — only `needs-human` verdicts can be false positives here. Other verdicts reflect real review work.
- `'needs-human' in recognized` — defensive: only discard if the calling lane recognizes `needs-human` as a verdict.
- `looksLikeStaleResumeAcknowledgement(review) === true` — the review text carries the stale-resume signature.

When all four hold, return `true` and the caller falls back to an actionable reason (e.g., "security review produced no parseable verdict after 2 attempts"). The fallback reason is one that `TRIAGE_RECOVERABLE_ERROR` in [[agents/platform-director]] recognizes as inconclusive, so the triage re-runs the review ONCE as a fresh session (no resume).

## Wire-in — `resolveReviewVerdict` in the security-review lane

[[../../../scripts/builder-worker]] `resolveReviewVerdict` runs attempt 2 as a same-session JSON parse-repair re-prompt (cheap, reuses context). When the re-prompt yields a parsed verdict, it calls `shouldDiscardStaleResumeVerdict({ useRepair: true, verdict, review: raw_response, recognized })` BEFORE accepting the verdict. On `true`, the helper falls through to `fallbackReason` — a description `TRIAGE_RECOVERABLE_ERROR` recognizes, triggering a fresh-session re-run in [[agents/platform-director]] `reconcileNeedsAttention`.

Same predicate is available to [[repair-agent]] and [[regression-agent]] (which also use `resolveReviewVerdict`), so any lane that resumes to repair a verdict benefits from stale-resume detection.

## Related

- [[../specs/inflection-resession-must-act-on-newest-ask]] — the parent spec.
- [[./security-agent]] — the caller lane; § Unparseable/unrecognized verdict documents the integration.
- [[agents/platform-director]] — the reconcile triage that re-runs a fresh session on a recoverable error.
