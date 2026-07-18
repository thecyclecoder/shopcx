# libraries/ad-review-feedback-router

Phase 2 of [[../specs/ceo-manual-ad-review-inline-per-element-feedback-routed-to-dahlia-max-render|ceo-manual-ad-review-inline-per-element-feedback-routed-to-dahlia-max-render]]. A pure planner + a chokepoint enqueuer that turn a persisted [[../tables/ad_review_feedback]] packet into the exact `agent_jobs` re-drives the spec calls for — so the CEO's inline per-element notes become surgical edits rather than a blurry whole-ad rewrite.

**File:** `src/lib/ads/ad-review-feedback-router.ts` · **Kind:** deterministic-Node lane (`ad-review-feedback` in [[builder-worker]]).

## Exports

| Export | Purpose |
|---|---|
| `routeAdReviewFeedback(packet, {adCampaignId, adReviewFeedbackId})` | **Pure** planner. Maps `packet.entries[]` → one `AdReviewRedriveSpec` per entry (in packet order), then appends **exactly one** trailing whole-ad `ad-creative-copy-qc` re-QA spec (`mode:'final-re-qa'`). Untargeted elements (empty comment boxes) don't reach this function — [[../tables/ad_review_feedback]]'s parser drops them at build time — so a filled-count of N always produces N + 1 specs. |
| `transitionAdReviewFeedbackStatus(admin, {workspaceId, id, from, to})` | **Compare-and-set** status mutator — matches `(workspace_id, id, status=from)` and asserts exactly one row transitioned. The idempotency backbone: `enqueueAdReviewFeedback` gates every side effect on this returning `true`. |
| `enqueueAdReviewFeedback(admin, {workspaceId, adReviewFeedbackId, specSlug?})` | The end-to-end dispatcher the box-worker lane calls. Reads the queued row, calls `routeAdReviewFeedback`, inserts one `agent_jobs` row per spec (kind + JSON instructions), and flips `queued → processing → done`. Returns `{dispatched, specs, jobIds}` — `dispatched:false` on a no-op (row not queued) or on a lost race. A partial dispatch parks the row `failed` before rethrowing so it never sits `processing` forever. |

## Per-entry routing

| Packet entry `targetKind` | Enqueued kind | Extra instruction fields |
|---|---|---|
| `copy-variation` | `ad-creative-copy-author` | `framework` |
| `canonical-copy` | `ad-creative-copy-author` | — |
| `render-format` | `ad-creative` | `format` |
| `max-grade` | `ad-creative-copy-qc` | `mode:'correction'` |
| _(trailing re-QA — not a packet entry)_ | `ad-creative-copy-qc` | `mode:'final-re-qa'` |

Every spec's instructions ALSO carry `ad_review_feedback_id` + `ad_campaign_id` — the join keys the receiving lane reads to look up the packet + campaign without a second async round-trip.

## Callers

- `runAdReviewFeedbackJob` in [[builder-worker]] (`kind='ad-review-feedback'`) — the deterministic-Node consumer. Reads `job.instructions.ad_review_feedback_id`, calls `enqueueAdReviewFeedback`, then flips `agent_jobs.status='completed'`. Always emits `emitAgentHeartbeat('ad-review-feedback', ok, latencyMs)` in a `finally` (the CLAUDE.md node-completeness invariant).
- `POST /api/ads/campaigns/[id]/review-feedback` in `src/app/api/ads/campaigns/[id]/review-feedback/route.ts` — enqueues the `ad-review-feedback` agent-jobs row right after `insertAdReviewFeedback` returns, so the feature works end-to-end without a separate cron. A driver error on the enqueue is logged but does NOT 500 the submit; the row is persisted (status='queued') and a future worker sweep can pick it up.

## Ownership

- **Owner:** `growth` (Max) via [[control-tower-node-registry]] `KIND_OWNER_FALLBACK` — the same owner the underlying ad-creative lanes carry.
- **Persona (box card):** Dahlia — she's the acting persona for the CEO-review re-drive because the router's per-entry re-drives all resolve to her authoring / regenerating loop. Wired in `src/lib/agents/personas.ts` `KIND_PERSONA_ALIAS.ad-review-feedback = "ad-creative"`.
- **Kill switch:** inherits `dept:growth` via the [[control-tower/kill-switch-resolver]] ancestry walk — flipping the Growth department switch off silently stops the router (fail-open on missing rows; the CEO must explicitly write a row).

## Gotchas

- **The router is pure — its `enqueue*` twin is the only writer.** A caller that hand-inserts an `agent_jobs` row from a raw `routeAdReviewFeedback` result skips the compare-and-set status transition and produces duplicate re-drives on a same-row double-dispatch. Always go through `enqueueAdReviewFeedback`.
- **`failed` is terminal in Phase 2.** A partial dispatch flips the row `failed` and rethrows; a follow-up re-drive requires an explicit re-queue (the Phase-3 CEO-cockpit "retry" affordance).
- **The `render-format` receiving lane now honours `revise_reason` — surgical in-place edit, not a fresh whole-pack.** `runAdCreativeJob` in [[builder-worker]] detects `{ad_campaign_id, format, revise_reason}` on the instructions payload and hands off to [[regenerate-existing-format]] `regenerateExistingFormat`, which regenerates ONLY the named format on the EXISTING [[../tables/ad_campaigns]] row (via [[../tables/ad_videos]] `campaign_id`+`format` lookup) with the CEO note threaded into the render prompt (`CEO_EDIT_HEADER` in [[creative-generate]] `buildPrompt`). NO new `ad_campaigns` row is ever inserted. `runAdCreativeCopyAuthorJob` / `runAdCreativeCopyQcJob` still ignore the `revise_reason` + target fields; consuming them for a targeted re-drive on the copy / QC lanes is the follow-up. See [[../specs/ceo-feedback-render-edits-the-existing-ad-format-in-place-not-a-new-whole-pack-ad]].

---

[[../README]] · [[../../CLAUDE]] · [[../tables/ad_review_feedback]] · [[creative-agent]] · [[ad-render]]
