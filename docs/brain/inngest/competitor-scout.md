# inngest/competitor-scout

The Competitor Scout discovery pass — LLM + web-search identification of a product's competitive set, written as `status='proposed'` for owner approval. M1 of [[../goals/acquisition-research-engine]]. See [[../specs/competitor-scout]].

**File:** `src/lib/inngest/competitor-scout.ts`

## Functions

### `competitor-scout-discover`
- **Trigger:** event `ads/competitor-scout.discover` `{ workspaceId, productId }`
- **Retries:** 1
- Returns `{ skipped }` if `workspaceId`/`productId` missing. Otherwise runs [[../libraries/competitors]] `discoverCompetitors` in one `step.run` → `{ proposed, skippedExisting, candidates }`.
- Fired by the owner surface `POST /api/ads/competitors { workspaceId, productId }`.

> The **category-sweep promotion** signal is NOT a separate function — it runs as a `promote-${workspaceId}` step inside [[creative-finder]]'s daily cron (it reads that cron's own sweep output).

## Downstream events sent

_None._

## Tables written

- [[../tables/competitors]] (via [[../libraries/competitors]] `discoverCompetitors` — `source='llm'`, `status='proposed'`, deduped)
- `ai_token_usage` (web-search discovery usage, via [[../libraries/ai-usage]])

## Tables read (not written)

- [[../tables/products]] (product intelligence frames the competitive set)
- [[../tables/competitors]] (dedup against existing rows)

## Gotchas

- **Proposes only** — never `approved`. The owner approves via `/api/ads/competitors/[id]`.
- Web search resumes through `pause_turn` (≤6 turns, `max_uses: 5`), mirroring the blog writer.

---

[[../README]] · [[../libraries/competitors]] · [[../tables/competitors]] · [[creative-finder]] · [[../specs/competitor-scout]] · [[../../CLAUDE]]
