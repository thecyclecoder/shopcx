# vale-reactive-spec-review

**Owner:** [[../functions/platform]]
**Parent:** [[../functions/platform]] — Autonomous build platform mandate.

The spec-review lane's leg of the [[../operational-rules#PM-agent activation contract|PM-agent activation contract]] — Vale's spec-review enqueue is now gated on "lacks a current Vale review" and reactively fires on spec mutation, so the up-to-cadence lag of the cron-only shape is closed without letting Vale re-review a spec that already passed.

## Phases

### Phase 1 — gate on "lacks a current Vale review"
- Rename `selectInReviewSpecs → selectUnreviewedInReviewSpecs` and add the `vale_pass !== true` filter so already-passed in_review specs are skipped by the review lane.
- `enqueueSpecReviewIfDue` returns `reason='no-unreviewed-specs'` when the `in_review` pool is non-empty but fully Vale-passed, and `reason='no-in-review-specs'` when empty — legible for heartbeat logs.
- Swap all callers in `scripts/builder-worker.ts` (main `runSpecReviewJob`, defensive re-check, and the `platform-director` standing-pass backstop).
- Retire the obsolete docstring claim that Vale re-reviews every `in_review` spec — a re-author now NULLs `vale_pass` via `markSpecCardBackToReview`, so filtering on `vale_pass !== true` correctly re-admits invalidated passes.

### Phase 2 — reactive Inngest fire
- Add `src/lib/inngest/spec-review-on-mutate.ts` — Inngest consumer that reads the event's slug and calls `enqueueSpecReviewIfDue`.
- Register the function in `src/lib/inngest/registered-functions.ts`.
- Fire the fire-and-forget event (`inngest.send(...).catch(()=>{})`) at `authorSpecRowStructured`, `authorSpecRowFromMarkdown`, and `markSpecCardBackToReview` — the three mutation sites that transition a spec into (or back into) `in_review`.
- The `spec-review-cron` remains the gated backstop; the gate makes reactive-first + cron-backstop safe (any race no-ops via the one-in-flight guard).

## Verification
- `selectUnreviewedInReviewSpecs` filters `vale_pass !== true`; a Vale-passed spec is never re-reviewed.
- `enqueueSpecReviewIfDue` returns the two distinct legible reasons above so heartbeat logs distinguish empty pool from fully-passed pool.
- The reactive Inngest event fires from each of the three mutation sites listed above; its consumer routes through `enqueueSpecReviewIfDue`.
- A re-author of a passed spec (`markSpecCardBackToReview`) NULLs `vale_pass` AND re-fires the reactive event, so the spec re-enters the queue without waiting on the cron.
