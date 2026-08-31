# inngest/review-request-canary-digest-cron

Daily cron that raises ONE CEO-inbox `dashboard_notifications` card per workspace-day summarizing the review-request drafts on canary hold. Phase 3 of [[../specs/review-request-sol-session]].

**File:** `src/lib/inngest/review-request-canary-digest-cron.ts`

## Why

Per the spec § "The gap that needs closing":

> `pending_send_at` is only rendered INSIDE an individual ticket — there is no list view. Twenty drafts scattered across twenty tickets is not a review queue, it is a scavenger hunt against a cron. So while the canary flag is on: hold each draft with a LONG pending_send_at (12-24h rather than minutes) and raise ONE digest card in the CEO inbox per batch.

That's this cron.

## Functions

### `review-request-canary-digest-cron`
- **Trigger:** cron `0 8 * * *` (daily at 08:00 UTC — well before US morning open)
- **Retries:** 1 · **Concurrency:** 1

Two passes per tick:

1. **`raise-digests`** — sweep `review_message_drafts` in the last 24h whose `outcome='drafted'` (the canary-held state). Group by `workspace_id`, then per workspace:
   - Build the day dedupe key via `reviewCanaryDigestDedupeKey(workspaceId, now)` → `review_request_canary_digest:<workspace_id>:<YYYY-MM-DD>`.
   - Confirming-predicate read against `dashboard_notifications` — a card already carrying this dedupe key today ⇒ no-op (guard-before-mutation per coaching #11).
   - Compose the digest body via `composeReviewCanaryDigestBody` — pluralizes the count, quotes the earliest send window, lists up to 20 ticket links.
   - Insert one `dashboard_notifications` row: `type='agent_approval_request'`, `metadata.routed_to_function='ceo'`, `metadata.escalation_kind='review_request_canary_digest'`, `metadata.dedupe_key=<key>`, `metadata.draft_count=N`. Same shape [[../libraries/ship-time-backfill-detector]] uses for the ship-time-backfill escalation card.

2. **`emit-heartbeat`** — `emitCronHeartbeat("review-request-canary-digest-cron", { ok:true, produced:{ workspaces, cards, drafts } })` — every tick (idle or not).

**Kill switch (CLAUDE.md hard rule — supervisable autonomy):** `enforceSwitch("review-request-canary-digest-cron")` is the **first body statement**. A blocked cascade writes a `blocked_off` heartbeat via the resolver and returns immediately.

**Cadence + liveness** — `expectedCadence: "daily (0 8 * * *)"`, `livenessWindowMs: 30h` (≥ 1.2× the 24h cadence per `assertRegistryInvariants`). `registeredAt: "2026-08-28T00:00:00Z"` graces the first-tick window (newcron-grace).

## Downstream events sent

_None._ The cron writes directly to `dashboard_notifications`; the CEO's daily inbox reads them.

## Related

- **Drafts persistence** — [[../tables/review_message_drafts]] (`outcome='drafted'` is the canary-held state).
- **Delivery SDK** — [[../libraries/review-request-delivery]] `REVIEW_REQUEST_CANARY_HOLD_MS` — the 18h hold each draft ships with.
- **Nudge cron** — [[review-request-nudge-cron]] — Phase 3's follow-up half.
- **Pattern** — [[../libraries/ship-time-backfill-detector]] — the same `dashboard_notifications` `agent_approval_request` shape.
- **CANARY off** — a config flag, not a rewrite: when off, the delivery SDK's holdMs drops to the normal response delay and this cron's inner work short-circuits (no drafts land in the 24h window ⇒ no digest).

---

[[../README]] · [[../../CLAUDE]] · [[../tables/review_message_drafts]] · [[review-request-nudge-cron]]
