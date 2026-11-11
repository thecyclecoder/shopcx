# inngest/review-request-canary-digest-cron

Daily cron that records ONE non-approval `director_activity` ledger row per workspace-day summarizing the review-request drafts on canary hold. Phase 3 of [[../specs/review-request-sol-session]], amended by [[../specs/review-request-digest-not-a-ceo-card]].

**File:** `src/lib/inngest/review-request-canary-digest-cron.ts`

## Why

Original Phase-3 intent (spec § "The gap that needs closing"):

> `pending_send_at` is only rendered INSIDE an individual ticket — there is no list view. Twenty drafts scattered across twenty tickets is not a review queue, it is a scavenger hunt against a cron. So while the canary flag is on: hold each draft with a LONG pending_send_at (12-24h rather than minutes) and raise ONE digest card in the CEO inbox per batch.

**Amended 2026-11-11 (review-request-digest-not-a-ceo-card):** the founder said *"no more review request drafts.. I don't think we need those as ceo cards anymore"*. The drafts send on their own schedule regardless, so the digest is a pure FYI that needs no decision — and an FYI does not belong in the CEO approvals inbox. The cron **no longer inserts a CEO-routed `agent_approval_request` `dashboard_notifications` card**. It records a non-approval `director_activity` ledger row instead, which surfaces in the owner's activity feed / EOD recap but never counts toward the CEO approvals feed.

## Functions

### `review-request-canary-digest-cron`
- **Trigger:** cron `0 8 * * *` (daily at 08:00 UTC — well before US morning open)
- **Retries:** 1 · **Concurrency:** 1

Two passes per tick:

1. **`raise-digests`** — sweep `review_message_drafts` in the last 24h whose `outcome='drafted'` (the canary-held state). Group by `workspace_id`, then per workspace:
   - Build the day dedupe key via `reviewCanaryDigestDedupeKey(workspaceId, now)` → `review_request_canary_digest:<workspace_id>:<YYYY-MM-DD>`.
   - Confirming-predicate read against `director_activity` — a row already carrying this `action_kind` + dedupe key today ⇒ no-op (guard-before-mutation per coaching #11).
   - Compose the digest body via `composeReviewCanaryDigestBody` — pluralizes the count, quotes the earliest send window, lists up to 20 ticket links.
   - Record ONE `director_activity` row via `recordDirectorActivity` (best-effort, never throws): `director_function='cs'` (the review-request owner — Sol reports to June), `action_kind='review_request_canary_digest'`, `reason=<digest body>`, `metadata.dedupe_key=<key>`, `metadata.draft_count=N`, `metadata.earliest_send_at`. **No `dashboard_notifications` row, no CEO routing** — this is an informational ledger entry, not an approval card.

2. **`emit-heartbeat`** — `emitCronHeartbeat("review-request-canary-digest-cron", { ok:true, produced:{ workspaces, digests, drafts } })` — every tick (idle or not).

**Kill switch (CLAUDE.md hard rule — supervisable autonomy):** `enforceSwitch("review-request-canary-digest-cron")` is the **first body statement**. A blocked cascade writes a `blocked_off` heartbeat via the resolver and returns immediately.

**Cadence + liveness** — `expectedCadence: "daily (0 8 * * *)"`, `livenessWindowMs: 30h` (≥ 1.2× the 24h cadence per `assertRegistryInvariants`). `registeredAt: "2026-08-28T00:00:00Z"` graces the first-tick window (newcron-grace).

## Downstream events sent

_None._ The cron writes one `director_activity` ledger row per workspace-day via `recordDirectorActivity`; it no longer touches `dashboard_notifications` and raises no CEO approval card.

## Related

- **Drafts persistence** — [[../tables/review_message_drafts]] (`outcome='drafted'` is the canary-held state).
- **Delivery SDK** — [[../libraries/review-request-delivery]] `REVIEW_REQUEST_CANARY_HOLD_MS` — the 18h hold each draft ships with.
- **Nudge cron** — [[review-request-nudge-cron]] — Phase 3's follow-up half.
- **Ledger** — [[../tables/director_activity]] via [[../libraries/director-activity]] `recordDirectorActivity` — the non-approval FYI row this cron now writes (`action_kind='review_request_canary_digest'`, owner `cs`).
- **CANARY off** — a config flag, not a rewrite: when off, the delivery SDK's holdMs drops to the normal response delay and this cron's inner work short-circuits (no drafts land in the 24h window ⇒ no digest row).

---

[[../README]] · [[../../CLAUDE]] · [[../tables/review_message_drafts]] · [[review-request-nudge-cron]]
