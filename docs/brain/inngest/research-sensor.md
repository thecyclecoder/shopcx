# inngest/research-sensor

Rhea's **paced hourly claim** of the top-spend unreviewed research URL — the real trigger of the research pipeline, one-at-a-time. Phase 1 of [[../specs/rhea-research-automation]] · slice 3 of [[../goals/acquisition-research-engine]] · owner [[../functions/growth]] (Ada/[[../functions/platform]] builds).

**File:** `src/lib/inngest/research-sensor.ts`

## Functions

### `research-sensor-cron`
- **Trigger:** cron `0 * * * *` (hourly)
- **Retries:** 1
- Scope: ad-tool workspaces (those with [[../tables/ad_campaigns]]) — same scope as [[creative-finder]] + [[acquisition-research-cadence]].
- Per workspace, in a `sensor-${ws}` step:
  1. **sync** — [[../libraries/research-urls]] `syncResearchUrlsFromCreatives` → pull any new scout destinations into [[../tables/research_urls]] (idempotent upsert on `(workspace_id, url)`).
  2. **dedup** — probe `agent_jobs` for an in-flight `kind='research'` row (`queued` | `queued_resume` | `building` | `claimed`) for this workspace. If one exists, SKIP this tick (true one-at-a-time; the box lane is single-file). Fails closed on a probe error.
  3. **claim** — pick the next row where `classification IS NULL AND teardown_verdict='unreviewed'`, ordered `ad_count DESC, first_seen ASC` — investigate the landers competitors spend the MOST behind first, tiebroken by earliest sighting. Zero claimable rows ⇒ no-op.
  4. **enqueue** — one `research` [[../tables/agent_jobs]] row with `spec_slug='research'`, `status='queued'`, `instructions=JSON.stringify({ research_url_id })`.
- Ends with a Control-Tower heartbeat (`emit-heartbeat`) so a healthy-but-idle run still beats ([[../libraries/control-tower/heartbeat]]).

## Registered as
- [[../libraries/control-tower/registry]] `MONITORED_LOOPS` `research-sensor-cron` — `owner:'growth'`, `personaKind:'research'` (merges into Rhea under Max on the Growth org view alongside [[creative-finder]] + [[acquisition-research-cadence]]).

## Tables written
- [[../tables/research_urls]] — indirectly, via `syncResearchUrlsFromCreatives` (upsert).
- [[../tables/agent_jobs]] — one `kind='research'` row per beat when a claim lands.
- [[../tables/loop_heartbeats]] — end-of-run beat under `loop_id='research-sensor-cron'`.

## Downstream
- The box worker's `research` lane ([[builder-worker]] `runResearchJob`) captures + classifies via Rhea (Max session) and writes back through the [[../libraries/research-urls]] SDK.

## Gotchas
- **One-at-a-time is enforced by dedup, not concurrency.** The claim query returns the top row; the DEDUP probe on `agent_jobs` guarantees the second tick during an in-flight run enqueues nothing. Rely on the probe, not on job-lock timing.
- **The claim filters `classification IS NULL`** — a Phase-2 deterministic-gated row (`excluded` / `checkout`, when that lands) is INVISIBLE to the claim, so a gated URL is never enqueued.
- **`instructions` carries the URL id.** The worker still batches by ad_count DESC (its own filter), but the claimed URL is guaranteed to be in-scope for the batch it runs, so the sensor's "top-spend URL got picked" contract holds regardless of batch cap.
- **Supersedes the slice-1 stub.** [[acquisition-research-cadence]] no longer enqueues `research` jobs; the hourly claim is now the real trigger.
- **Idempotent by construction** — sync's upsert + the agent_jobs dedup + the one-URL claim make every tick safe to re-run.

---

[[../README]] · [[creative-finder]] · [[acquisition-research-cadence]] · [[../libraries/research-urls]] · [[../libraries/control-tower/registry]] · [[../libraries/control-tower/heartbeat]] · [[../specs/rhea-research-automation]] · [[../specs/rhea-url-sensor]] · [[../functions/growth]] · [[../functions/platform]] · [[../../CLAUDE]]
