# libraries/ad-avatar-proposals

Ad tool — Phase 2 demographic-driven avatar proposals. Reads **who actually buys** a product and asks Opus for archetype briefs the operator confirms BEFORE any photo upload or Higgsfield spend. Opus-only, single-digit cents — no generative spend at this stage.

**File:** `src/lib/ad-avatar-proposals.ts` · Model: `OPUS_MODEL` from [[ai-models]] · READ-ONLY consumer of the [[../lifecycles/demographic-enrichment]] pipeline.

## Exports

### `generateAvatarProposals` — function

```ts
function generateAvatarProposals(productId: string, maxArchetypes = 5, forceRefresh = false): Promise<GenerateProposalsResult>
// GenerateProposalsResult = { ok, proposals: ProposalDraft[], reason? }
```

1. Builds a **title stem** from the product title's first two words.
2. Resolves the buyer cohort via RPC `ad_product_cohort(p_workspace_id, p_title_stem)` — a title `ILIKE` match against `orders.line_items`.
3. Dedups each person to one via their `customer_links` group (ungrouped customers count as their own group).
4. Loads `customer_demographics` for the deduped set and keeps only the **FOUR demographic fields**: `inferred_gender`, `inferred_age_range`, `inferred_life_stage`, `zip_income_bracket`. Skips `unknown` / low-confidence gender (`inferred_gender_conf < 0.6`).
5. If the cohort is `< 30` (`MIN_COHORT`), **falls back** to the workspace-wide `demographics_snapshots` row (`product_id IS NULL`), synthesizing one representative tuple from the dominant buckets.
6. Picks the top-share tuples (1 on fallback, else `maxArchetypes` — **default 5**), gets an Opus `ArchetypeBrief` per archetype, and inserts `status='proposed'` rows into `ad_avatar_proposals`.

Each proposal carries a `demographic_basis` (cohort size + per-field share + `used_fallback_snapshot`) so the operator sees what the archetype is grounded in. The returned `archetype_brief` also carries the archetype's own `gender` + `age_range` tuple — these **pre-fill the avatar face dropdowns** on the generate-faces screen so the operator starts from the cohort's actual gender/age.

### Write-through archetype cache

Resolving the JOINT four-field archetypes from raw [[../tables/customer_demographics]] is the expensive step, so it's write-through cached on [[../tables/demographics_snapshots]]`.archetype_tuples` (the per-product row, or `product_id IS NULL` on fallback). Behavior (`ARCHETYPE_CACHE_TTL_MS = 7 days`):

- **Cache hit + fresh** (computed within 7 days, `forceRefresh=false`) → reuse the cached archetypes + basis, no raw recompute.
- **Cache absent / stale (>7 days) / `forceRefresh=true`** → recompute live from the cohort, then best-effort write the result back to `archetype_tuples`.

Degrades gracefully: if the cache column/write fails, it always live-computes — the cache write is never load-bearing.

## Callers

- `src/app/api/ads/proposals/route.ts` — generate/list avatar proposals

## Gotchas

- **Uses ONLY the four-field demographic tuple.** Explicitly NOT `health_priorities`, `buyer_type`, or urban/geo fields — wardrobe + setting anchor to income bracket + life stage, never health interests.
- **Never writes `customer_demographics`** — it is a pure read-side consumer of the enrichment pipeline.
- Opus failure falls back to a deterministic brief (no throw); `no_demographic_data` is returned only when both the cohort and the snapshot are empty.
- The cohort RPC matches on title stem, so two products sharing a stem ("Amazing Coffee Regular" / "…Decaf") will pool buyers — intentional for thin per-SKU cohorts.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/ad_avatar_proposals]] · [[../tables/ad_avatars]]
