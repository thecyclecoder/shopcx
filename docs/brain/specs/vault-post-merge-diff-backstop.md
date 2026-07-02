# vault-post-merge-diff-backstop

**Owner:** [[../functions/platform]]
**Parent:** [[../functions/platform]] — Autonomous build platform mandate.

The security-review lane's leg of the [[../operational-rules#PM-agent activation contract|PM-agent activation contract]] — the reactive post-merge diff-mode security review fires on the merge hook, and a standing-pass + daily-cron backstop routes through the identical gate so a Vercel reap or a dropped Inngest send never leaves a merged SHA unreviewed.

## Phase 1 (one-shot) — diff-leg backstop
- Add `enqueueSecurityDiffIfDue(admin, opts?)` in `src/lib/security-agent.ts` — enumerates recently-merged `claude/*` builds (`agent_jobs` `kind='build'`, `status='merged'`, `updated_at` within 14d), resolves merge SHA(s) per build from spec provenance (per-phase `spec_phases.merge_sha` + `specs.last_merge_sha` for one-shots), and (idempotently, via the existing 14d SHA dedup inside `enqueueSecurityReviewJob` diff mode) re-fires the diff-mode enqueue for any SHA lacking a `security_reviews` row.
- Wire the re-sweep into the `platform-director` standing pass in `scripts/builder-worker.ts` next to `backstopPreMergeChecks`.
- Hang the re-sweep off the daily `src/lib/inngest/security-dep-watch.ts` cron as a second net.
- Leave the reactive merge-hook enqueue at `src/lib/agent-jobs.ts:2160` untouched — this is purely additive; the backstop routes through the identical `enqueueSecurityReviewJob` diff-mode chokepoint so a race with the reactive fire is a clean no-op.

## Verification
- `enqueueSecurityDiffIfDue` exists in `src/lib/security-agent.ts` and enumerates recent-merged builds' SHA provenance from `spec_phases.merge_sha` + `specs.last_merge_sha`.
- The `platform-director` standing pass and the `security-dep-watch` daily cron both call `enqueueSecurityDiffIfDue`; each merged SHA lacking a `security_reviews` row is (re-)enqueued.
- The reactive merge-hook enqueue at `src/lib/agent-jobs.ts:2160` is unchanged; a race between the merge-hook fire and the standing-pass/cron backstop dedupes via the existing 14d SHA guard inside `enqueueSecurityReviewJob`.
