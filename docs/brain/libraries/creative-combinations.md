# `src/lib/ads/creative-combinations.ts`

The **SDK chokepoint** for the coverage ledger at the freshness grain — one row per `(angle × pattern)` per workspace on [[../tables/ad_creative_combinations]]. Every read and write of the ledger goes through here; never raw `.from('ad_creative_combinations')` outside this file (shopcx no-raw-`.from()` rail).

The combination = an [[angle-palette|`ProductAngle`]] × a [[headline-patterns|`HeadlinePattern`]]. The angle and pattern each carry their own coverage; this ledger tracks the specific pairing that becomes an ad — the "never ship the same ad twice" memory that closes the loop back to performance via `campaign_id`.

Wired by [[../specs/wire-engine-into-dahlia-author-path]] (Phase 3). [[creative-agent]] `insertReadyCreative` upserts the combination row BEFORE the [[../tables/ad_campaigns]] insert (so `creative_combination_id` is a real FK) and bumps its coverage AFTER, alongside [[angle-palette]] `markAngleUsed` — the pair advances both sides of the ledger in one call site.

## Exports

- **`listCombinationsForProduct(admin, {workspaceId, productId, status?})` → `Promise<CreativeCombination[]>`** — the READER the [[selection-engine]] leans on. Returns every ledger row for `(workspace_id, product_id)`, optionally narrowed to a `status` (typically `'fresh'`). The selector applies the cooldown / palette-join / pattern-fillability filters in memory so the freshness horizon (`COOLDOWN_DAYS`) lives in one place. Landed by [[../specs/selection-engine-coverage-ledger]] Phase 1.
- **`upsertCombinationForPair(admin, {workspaceId, productId, angleId, patternId})` → `Promise<string>`** — *(landed by [[../specs/wire-engine-into-dahlia-author-path]] Phase 3)* idempotent upsert on the unique key `(workspace_id, angle_id, pattern_id)`. First call inserts a fresh row (`times_used: 0`, `last_used_at: null`, `status: 'fresh'`); subsequent calls no-op-return the existing id. Returns the combination id — hand-back to `insertReadyCreative` so `ad_campaigns.creative_combination_id` gets the real FK.
- **`bumpCombinationUsed(admin, combinationId, nowIso, campaignId)` → `Promise<void>`** — *(landed by [[../specs/wire-engine-into-dahlia-author-path]] Phase 3)* read-then-write bump of `times_used` + set `last_used_at = nowIso` + set `campaign_id = campaignId`. The freshness/coverage heartbeat that drives the ~30–45d cooldown and the perf link the factor rollup joins on.

## Callers / purpose

- **[[selection-engine]] `listEligibleCombinations`** — the sole live READER (Phase 1). Fetches the fresh ledger rows for a product, joins them against the palette + patterns via their SDKs, and applies the `COOLDOWN_DAYS` horizon in memory.
- **[[creative-agent]] `insertReadyCreative`** *(wire-engine Phase 3)* — the sole live WRITER. Upserts BEFORE the campaign insert (to fill the FK); bumps AFTER (to advance the ledger + close the perf link). Both calls sit inside the same author-path branch that also fires `markAngleUsed`, so a bin insert either advances both sides of the ledger or neither.
- **[[creative-agent]] `buildAdCampaignInsertBody`** *(wire-engine Phase 3)* — reads the `combinationId` returned by `upsertCombinationForPair` and stamps it as `creative_combination_id` on the row body alongside the other three factor stamps (`creative_theme`, `angle_palette_id`, `headline_pattern_id`).
- **M4 selection picker** (later, [[../specs/selection-engine-coverage-ledger]] Phase 2): layers the theme-spread rail + loser filter + 70/30 explore/exploit on top of `listEligibleCombinations` — reads the same ledger, no new access path.
- **M5 factor rollup** (later): joins Meta results back to `{theme, angle, pattern, combination}` via the `campaign_id` link + [[../tables/ad_campaigns]]'s reciprocal `creative_combination_id` stamp to re-weight selection (exploit crowned winners, down-weight losers).

## Gotchas

- **`bumpCombinationUsed` is read-then-write, not atomic.** Two concurrent bin inserts of the same `(angle, pattern)` pair can each read the same `times_used` and both write `n+1` (losing one increment). Coverage is a freshness heuristic, not billing; acceptable today. Same shape as [[angle-palette]] `markAngleUsed`.
- **The status enum differs from the angle's.** Combinations use `fresh` \| `tested` \| `crowned` \| `retired` (`tested`, past tense); [[../tables/product_angle_palette]].`status` uses `fresh` \| `testing` \| `crowned` \| `retired` (`testing`, present). Probe before assuming.
- **`campaign_id` is `on delete set null`** — a deleted campaign leaves the coverage memory intact (the pairing was still used), just severs the perf link. `bumpCombinationUsed` overwrites the previous `campaign_id` each time — the last/representative campaign is what stays.
- **`upsertCombinationForPair` handles the empty-selector path by never being called.** The caller ([[creative-agent]] `insertReadyCreative`) skips both the upsert and the bump when [[select-angle-pattern|`selectAnglePatternForBrief`]] returned `null` (unwired product, no legal pattern). The four factor stamps land NULL on that campaign row; the ledger is untouched.

[[../tables/ad_creative_combinations]] · [[angle-palette]] · [[headline-patterns]] · [[compose-headline]] · [[select-angle-pattern]] · [[creative-agent]] · [[../README]] · [[../../CLAUDE]]
