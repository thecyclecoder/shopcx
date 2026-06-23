# inngest/landing-page-scout

The Landing Page Scout **vision gap-analysis** pass — compares the latest captured competitor lander snapshots against ours, chapter by chapter, and writes proposed [[../tables/lander_recommendations]]. M3 of [[../goals/acquisition-research-engine]]. See [[../specs/landing-page-scout]].

**File:** `src/lib/inngest/landing-page-scout.ts`

## Functions

### `landing-page-scout-analyze`
- **Trigger:** event `ads/landing-page-scout.analyze` `{ workspaceId, productId? }`
- **Retries:** 1
- Returns `{ skipped }` if `workspaceId` missing. Otherwise runs [[../libraries/landing-page-scout]] `analyzeLanderGaps` in one `step.run` → `{ proposed, skippedExisting, competitorSnapshots, ourSnapshots, gaps }`.
- Fired by the owner surface `POST /api/ads/lander-scout { workspaceId, productId? }`, and by the box capture script after a snapshot run.

> The mobile per-chapter **capture** is NOT an Inngest function — Playwright can't run in serverless. It's the box script `scripts/landing-page-snapshot.ts`, which writes [[../tables/lander_snapshots]] then calls `analyzeLanderGaps` directly (or fires this event).

## Downstream events sent

_None._

## Tables written

- [[../tables/lander_recommendations]] (proposed gaps, deduped)
- `ai_token_usage` (vision usage, via [[../libraries/ai-usage]])

## Tables read (not written)

- [[../tables/lander_snapshots]] (the latest captured competitor + our snapshots)

## Related

[[../specs/landing-page-scout]] · [[../libraries/landing-page-scout]] · [[../tables/lander_snapshots]] · [[../tables/lander_recommendations]] · [[competitor-scout]]
