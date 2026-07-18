# ad_review_feedback

CEO manual-review feedback packets on a finished ad — storage for Phase 1 of [[../specs/ceo-manual-ad-review-inline-per-element-feedback-routed-to-dahlia-max-render]]. The ad detail page's annotation UI flips the read-only view into per-element comment mode (4 render formats + 5 copy variations + canonical copy + Max grade); Submit assembles a structured packet of only the non-empty comments and persists ONE row here. Each packet entry carries the exact target (`targetKind` + `format`/`framework`) so Phase 2's dispatcher can route each comment to the owning lane (copy→Dahlia revise, image→render regenerate, max→Max re-QA) instead of a blurry whole-ad rewrite.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `ad_campaign_id` | `uuid` | — | → [[ad_campaigns]].id · ON DELETE CASCADE |
| `packet` | `jsonb` | — | The full typed `AdReviewFeedbackPacket` — `{ entries: AdReviewFeedbackEntry[] }` where each entry is one of `{targetKind:'render-format', format:'feed_4x5'\|'stories_9x16'\|'reels_9x16'\|'right_column_1x1', comment}`, `{targetKind:'copy-variation', framework:'lf8'\|'schwartz'\|'cialdini'\|'hopkins'\|'sugarman', comment}`, `{targetKind:'canonical-copy', comment}`, or `{targetKind:'max-grade', comment}`. Empty comment boxes are dropped by the UI at build time AND rejected by `parseAdReviewFeedbackPacket` at write time (an empty `entries[]` is a 400). Open jsonb (no CHECK) so a new target-kind lands without a migration; the `.ts` parser is the shape gate. |
| `status` | `text` | — | default: `'queued'` · CHECK `in ('queued','processing','done','failed')`. Phase 1 always writes `queued`. Phase 2's dispatcher flips `queued → processing` on start, then `processing → done` on the final Max re-QA landing back in the bin, or `→ failed` on a hard error. |
| `created_by` | `uuid` | ✓ | The workspace member who submitted the packet (`auth.users.id`). Nullable so a Phase-2 system-triggered re-submit (webhook / cron) doesn't need a stub user. |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id` (ON DELETE CASCADE — a workspace teardown removes the packets)
- `ad_campaign_id` → [[ad_campaigns]].`id` (ON DELETE CASCADE — a campaign delete removes its packets)

## Indexes

- `ad_review_feedback_campaign_idx (ad_campaign_id, created_at desc)` — per-campaign read (newest packet first; the ad detail page's history reader).
- `ad_review_feedback_workspace_status_idx (workspace_id, status, created_at asc)` — Phase-2 dispatcher's queued-work read (oldest queued first so FIFO holds).

## RLS

Mirrors [[ad_campaigns]] · [[ad_creative_copy_qc_verdicts]]:
- `ad_review_feedback_service_all` — service role does all writes.
- `ad_review_feedback_member_select` — any authenticated workspace member can select.

## Writers

- `insertAdReviewFeedback(admin, {workspaceId, adCampaignId, packet, createdBy})` in `src/lib/ads/ad-review-feedback.ts` — the ONLY row-insert writer (CLAUDE.md 'raw `.from(...)` with no SDK → STOP' rule). Called from `POST /api/ads/campaigns/[id]/review-feedback` after `parseAdReviewFeedbackPacket` validates the request body. Writes `status='queued'`. On the same request the route ALSO enqueues one `agent_jobs.kind='ad-review-feedback'` row carrying `{ ad_review_feedback_id }` so the box worker's deterministic router picks it up on the next claim.
- `transitionAdReviewFeedbackStatus(admin, {workspaceId, id, from, to})` in `src/lib/ads/ad-review-feedback-router.ts` — the ONLY status-mutator, and it is a COMPARE-AND-SET (matches `(workspace_id, id, status=from)` and asserts exactly one row transitioned). `enqueueAdReviewFeedback` gates every side effect on this returning `true` so a same-row double-dispatch produces zero duplicate `agent_jobs` rows (the spec's idempotency rule).

## Readers

- `getAdReviewFeedbackForCampaign(admin, {workspaceId, adCampaignId})` — the ad detail page's history reader (newest first, `[]` when empty). Called from `GET /api/ads/campaigns/[id]/review-feedback`.
- `enqueueAdReviewFeedback(admin, {workspaceId, adReviewFeedbackId})` in `src/lib/ads/ad-review-feedback-router.ts` — the Phase-2 dispatcher's read: pulls the queued row, calls `routeAdReviewFeedback` to plan per-entry re-drives (copy → `ad-creative-copy-author`, image → `ad-creative`, max → `ad-creative-copy-qc`) + one trailing whole-ad `ad-creative-copy-qc` re-QA, inserts one `agent_jobs` row per plan step, and flips `queued → processing → done`. A non-queued row (already processing / done / failed) is a no-op. Invoked from `runAdReviewFeedbackJob` in `scripts/builder-worker.ts` (the `ad-review-feedback` lane).

## Gotchas

- **`packet` is jsonb but the shape is pinned in `.ts`.** `parseAdReviewFeedbackPacket` in `src/lib/ads/ad-review-feedback.ts` rejects an empty `entries[]`, an unknown `targetKind`, an unknown `format`/`framework`, a comment past `AD_REVIEW_COMMENT_MAX_LEN` (2000), and an empty comment string — a bypassed parser is a defect (writes should always come through the SDK helper which trusts its typed input). A future new target-kind lands without a migration but MUST also land in the parser + the dispatcher's exhaustive `switch` in the same PR.
- **`status='queued'` is written by the insert; `processing/done/failed` are owned by the Phase-2 router.** `enqueueAdReviewFeedback` in [[../libraries/ads/ad-review-feedback-router|ad-review-feedback-router]] transitions `queued → processing` via a compare-and-set (matches `(workspace_id, id, status='queued')`), then `processing → done` after every planned re-drive is enqueued. A partial dispatch (a driver error on one of the `agent_jobs` inserts) parks the row `failed` so it never sits `processing` forever, and rethrows so the worker log surfaces the reason. `failed` is terminal in Phase 2 — a Phase-3 CEO-cockpit "retry" affordance will re-queue it explicitly.
- **`created_by` may be null on a Phase-2 system-triggered submit.** Any reader that shows attribution must handle a null (e.g. "System" fallback), not assume there is always a member.
- **The 4 render formats are the Phase-1 UI's supported comment slots.** A placement with no canonical static (a not-yet-rendered slot) gets no comment box — surfacing one would produce a packet entry the Phase-2 render lane could not act on.
- **The 5 copy frameworks are the Phase-1 UI's supported comment slots.** A framework outside the canonical LF8 / Schwartz / Cialdini / Hopkins / Sugarman set (an older / experimental pack) renders on the page but gets no comment box — Phase 2's dispatcher only knows how to re-invoke Dahlia's revise for those 5.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]] · [[../specs/ceo-manual-ad-review-inline-per-element-feedback-routed-to-dahlia-max-render]]
