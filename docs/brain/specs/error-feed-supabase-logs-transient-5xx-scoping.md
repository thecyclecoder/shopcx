# Scope supabase-logs poller: transient-classify one-off edge 5xx / statement-timeout noise ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/supabase-log-poll.ts::monitor-false-positive`
**Repair-signature:** `cluster:repair`

Bring the supabase-logs error-feed poller to parity with its sibling feeds (vercel isBareLifecycle, inngest isTransientInngestTransportError) by classifying momentary edge 5xx / statement-timeout DB noise as transient, so a self-healing DB-saturation blip is recorded for visibility but auto-resolved and only escalates+pages on recurrence — while a chronic endpoint that 500s every poll still surfaces.

## Problem (from Control Tower signature `cluster:repair`)
pollSupabaseLogs (src/lib/control-tower/supabase-log-poll.ts) records EVERY api 5xx row (and postgres ERROR/FATAL) via recordError with no transient flag, so a one-off momentary edge blip — like this cluster's simultaneous transient 500s on GET /rest/v1/loop_heartbeats and GET /rest/v1/customers (collateral of a brief DB-saturation/timeout storm that self-healed) — mints a hard OPEN paged incident plus a repair fan-out. recordError already supports input.transient (auto-resolve first sighting, escalate only on recurrence within TRANSIENT_RECUR_WINDOW_MS) and the inngest path uses it (inngest-failure-capture.ts:78); the poller never does.

**Likely target:** `src/lib/control-tower/supabase-log-poll.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Shipped:** added `isTransientSupabaseLogNoise(kind, ctx)` to `src/lib/control-tower/error-feed.ts` (the supabase-logs sibling of `isBareLifecycle` / `isTransientInngestTransportError`) — `true` for any edge API 5xx (`500–599`) or a Postgres `statement timeout` / connection-saturation ERROR, never for a Postgres `FATAL`/`PANIC`, a non-timeout (constraint) ERROR, an auth error, or a non-5xx. `pollSupabaseLogs` (`supabase-log-poll.ts`) now carries a `transient` flag per grouped incident (computed in each `mapRow`) and passes it to `recordError`, so a self-healing blip auto-resolves on first sighting (recorded, no page, no repair fan-out) and only escalates on recurrence within `TRANSIENT_RECUR_WINDOW_MS`; a chronic 5xx still surfaces. Unit tests added to `error-feed.test.ts` (17 pass). Brain pages updated: [[../libraries/control-tower]] + [[../inngest/supabase-log-poll]]. `npx tsc --noEmit` clean.

## Verification
- Re-trigger the originating condition (signature `cluster:repair`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `cluster:repair` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
