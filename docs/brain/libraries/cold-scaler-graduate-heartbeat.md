# `src/lib/media-buyer/cold-scaler-graduate-heartbeat.ts`

Phase 3 of [[../specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]].

The deepest cause of the 2026-07-27 incident was not the ASC endpoint removal. It was that an autonomous rail could exist for weeks, never fire once, and look identical to a healthy rail that had no work to do. This module makes an unexercised cold-scaler rail **visible as unexercised** — by reading the durable activity ledger the Phase-1 graduate flow already writes ([[media-buyer-graduate-scaler]] emits `cold_scaler_graduated` on success and `cold_scaler_graduate_skipped` on any skip into [[../tables/director_activity]]) and turning it into (a) a per-cohort line on the [[media-buyer-director-digest|Growth Director digest]] and (b) a deduped CEO card when a cohort has an eligible crowned winner and no successful graduate inside a bounded window.

## Escalation predicate — precise on purpose

`isCohortGraduateStalled(h)` returns true only when both:

1. `eligibleWinnerCount > 0` — there is at least one crown-marker row in [[../tables/media_buyer_crowned_winners]] with a null `graduated_at` under the cohort's `(workspace, meta_ad_account, product)` scope. Nothing to graduate ⇒ nothing to alert on.
2. `lastGraduatedAt === null` inside the `GRADUATE_STALL_WINDOW_MS` window (7 days) — no successful `cold_scaler_graduated` [[../tables/director_activity]] row for the cohort inside the window.

A cohort with zero eligible winners is a **healthy quiet rail** and does not escalate. Alerting on it would train the CEO to ignore the signal — the exact anti-signal the spec exists to prevent.

## Exports

- `GRADUATE_STALL_WINDOW_MS = 7 days` — the bounded window used to read recent activity and to phrase the CEO card.
- `computeCohortGraduateHeartbeats(admin, {workspaceId, metaAdAccountId, nowMs?})` — reads active cohorts via [[cold-scaler-cohort]] `listActiveColdScalerCohorts`, latest graduate activity via `readRecentGraduateActivityByCohort`, and per-cohort eligible-winner counts via `countEligibleCrownedWinnersByCohort`; returns `CohortGraduateHeartbeat[]`.
- `formatCohortGraduateHeartbeatsForDigest(heartbeats, nowMs?)` — pure formatter. Returns one line per cohort: `↳ cohort {id8} — last graduated {age or "never"}, {N eligible winners}[, last skip: {reason}]`. Empty array when the workspace has no active cohorts.
- `isCohortGraduateStalled(h)` — the escalation predicate. Exported for direct unit-testability + composition.
- `escalateColdScalerGraduateStall(admin, {workspaceId, heartbeat, nowMs?})` — idempotent per `(workspace, cohort, UTC day)` via `metadata->>dedupe_key`. Raises one CEO-routed `dashboard_notifications` row (type `agent_approval_request`) naming the cohort, the eligible-winner count, and the last skip reason. Best-effort — a DB write failure logs and returns `{emitted:false}` rather than throwing.
- `runColdScalerGraduateStallCheck(admin, {workspaceId, metaAdAccountId, nowMs?})` — composes the two: computes heartbeats, fires escalations for stalled cohorts. Returns `{heartbeats, emitted}`.

## Caller

[[builder-worker]] `runMediaBuyerJob` invokes `runColdScalerGraduateStallCheck` once per active `meta_ad_account_id` right before `deliverMediaBuyerDigest`, then passes the accumulated heartbeats into the digest so the founder sees "Cold-scaler graduates: cohort {id8} — last graduated 12d ago, 3 eligible winners (last skip: not_armed)" on the SAME message that reports the promote/kill recommendations.

## Related

- [[../tables/director_activity]] — the source of truth the heartbeat reads.
- [[../tables/media_buyer_crowned_winners]] — provides the eligible-winner count via `graduated_at IS NULL`.
- [[../tables/media_buyer_cold_scaler_cohorts]] — enumerates the active cohorts.
- [[media-buyer-graduate-scaler]] — the Phase-1 writer whose audit rows this module reads.
- [[media-buyer-director-digest]] — the digest surface that carries the heartbeat lines.
- [[meta__dead-verb-escalation]] — the Phase-2 sibling CEO card for a removed Meta API surface.
- [[../functions/growth]] · [[../integrations/meta-marketing]]
