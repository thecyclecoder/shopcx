# inngest/cs-director-digest-composer

Weekly cron that composes the **CS Director → Founder storyline digest** (Phase 1 of [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]] — the M5 "autonomous CS Director" milestone).

**File:** `src/lib/inngest/cs-director-digest-composer.ts`

## Functions

### `cs-director-digest-composer`
- **Trigger:** cron `0 14 * * 1` (Monday 14:00 UTC — early US-business-hours Monday, so the founder reads the digest with the fresh week ahead)
- **Retries:** 1

Finds every workspace with ≥1 CS-director action or ≥1 resolution-event in the previous 7 days (any [[../tables/director_activity]] row with `director_function='cs'` + `action_kind='cs_director_call'`, OR any [[../tables/ticket_resolution_events]] row `staged_at` in the window), then calls [[../libraries/cs-director-digest]] `composeCsDirectorDigest(admin, workspaceId, since, until)` per workspace — which rolls up the sources into a `storylines` array and inserts one [[../tables/cs_director_digests]] row per (workspace, week).

The workspace filter is deliberately WIDE (any of either source suffices): a quiet week still emits a digest with `storylines=[]` rather than silently skipping — the founder surface (Phase 2) needs a stable "did the week compose?" signal, not an inferred absence.

Idempotent per `(workspace_id, digest_period_start)` — the composer's own `existingDigestFor` lookup short-circuits a second insert for the same period, so the `retries:1` retry never double-posts.

Ends with a Control Tower heartbeat (`emitCronHeartbeat("cs-director-digest-composer", …)`) — registered in [[../libraries/control-tower]] `MONITORED_LOOPS` (owner `cs`, weekly cadence).

## Downstream events sent

_None._ Phase 1 stops at persisting the digest row. Phase 2 will add a per-storyline mutation event (leash change / policy insert / rule insert) fired when the founder clicks a storyline action.

## Tables written

- [[../tables/cs_director_digests]] — one row per (workspace, week).

## Tables read (not written)

- [[../tables/director_activity]] — the `cs_director_call` verdicts source (precedent-call storylines).
- [[../tables/ticket_resolution_events]] — the recurring-problem source (early-warning storylines).

## Related

[[../libraries/cs-director-digest]] · [[../functions/cs]] · [[../goals/guaranteed-ticket-handling]] · [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]] · [[../specs/cs-director-third-rung-hard-calls-above-triage-quorum]] · [[daily-digest-cron]] · [[director-recap-cron]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
