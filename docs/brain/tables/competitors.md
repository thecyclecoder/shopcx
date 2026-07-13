# competitors

The DB-driven, supervisable competitor set — replaces the hardcoded `COMPETITOR_SEEDS` that used to live in `src/lib/adlibrary.ts`. The foundation (M1) of the [[../goals/acquisition-research-engine]]. The creative-finder sweep reads **approved** rows here per workspace; [[../specs/ad-creative-scout]] (M2) and [[../specs/landing-page-scout]] (M3) read the same set — neither re-derives competitors. See [[../specs/competitor-scout]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `product_id` | `uuid` | ✓ | The product they compete with → [[products]].id · ON DELETE SET NULL. Null for workspace-level competitors + the migrated seeds. |
| `brand` | `text` | — | Compact handle used AS the AdLibrary search keyword. Writer-normalized lowercase (`normalizeBrand`). |
| `domain` | `text` | ✓ | Canonical brand domain — the bridge to [[../specs/landing-page-scout]]. |
| `pdp_urls` | `text[]` | — | default: `'{}'` · canonical PDP/lander URLs (breadth source). |
| `category` | `text` | ✓ | Category overlap. |
| `spend_signal` | `text` | ✓ | Freeform ad-spend/longevity signal ('high', 'recurs in 3 sweeps', est. spend). |
| `source` | `text` | — | default: `'manual'` · CHECK ∈ `llm` \| `category_sweep` \| `manual` \| `whitelisted` |
| `search_keyword` | `text` | ✓ | The EXACT AdLibrary keyword the sweep searches (verbatim, NOT `normalizeBrand`-flattened). Whitelisted-page rows set this to the raw advertiser/page name (e.g. `Holistic Health Finds`) because the AdLibrary API matches page names literally. Normal competitors leave it null and the sweep falls back to `brand`. |
| `runs_ads_for` | `uuid` | ✓ | For `source='whitelisted'` rows, the competitor whose store this page fronts (destination-domain join target) → `competitors.id` · ON DELETE SET NULL. Null for real brand competitors. |
| `status` | `text` | — | default: `'proposed'` · CHECK ∈ `proposed` \| `approved` \| `rejected` |
| `evidence` | `text` | ✓ | Why they compete — the supervisable evidence shown before approval. |
| `reviewed_by` | `uuid` | ✓ | → `auth.users`.id · ON DELETE SET NULL (approve/reject audit). |
| `reviewed_at` | `timestamptz` | ✓ | |
| `review_note` | `text` | ✓ | |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

**Unique:** `(workspace_id, brand)` — one competitor brand per workspace. Dedups across discovery passes + category-sweep promotion, and ensures a **rejected** brand cannot re-surface (inserts dedup against ANY status).

**Indexes:** `(workspace_id, status)` (sweep read + owner list), `(workspace_id, product_id)` (per-product lookup).

## Foreign keys

**Out (this → others):**
- `workspace_id` → [[workspaces]].`id`
- `product_id` → [[products]].`id`
- `runs_ads_for` → `competitors`.`id` (self-FK; the fronted competitor for whitelisted pages)
- `reviewed_by` → `auth.users`.`id`

## Common queries

### Approved competitor seeds for the sweep (the read path)
```ts
const { data } = await admin.from("competitors")
  .select("brand, evidence, category")
  .eq("workspace_id", workspaceId).eq("status", "approved");
```

### Proposed rows awaiting owner review
```ts
const { data } = await admin.from("competitors")
  .select("id, brand, domain, source, evidence, spend_signal")
  .eq("workspace_id", workspaceId).eq("status", "proposed")
  .order("created_at", { ascending: false });
```

## Gotchas

- **Only `status='approved'` rows enter the live sweep** (north-star: the discovery agent writes `proposed` only; the owner approves). A `proposed`/`rejected` competitor never silently sweeps.
- **`brand` is the AdLibrary keyword** — keep it a compact lowercase handle (`everydaydose`, not `EverydayDose.com`). `normalizeBrand()` enforces this on writes; dedup is by this normalized value, so cross-naming variants (`RYZE Superfoods` vs `ryzesuperfoods`) may not collapse perfectly — the owner review catches strays.
- **`search_keyword` overrides `brand` for the sweep read** — a `source='whitelisted'` row stores the EXACT advertiser/page name in `search_keyword` because the AdLibrary API matches literally (`"Holistic Health Finds"` → 59 ads; the normalized `holistichealthfinds` → 0). The sweep read uses `search_keyword ?? brand`. Normal (`llm`/`category_sweep`/`manual`) competitors leave `search_keyword` null.
- **`source='whitelisted'`** = an affiliate/advertorial/creator page fronting a real competitor. `runs_ads_for` points at the fronted competitor row (the destination-domain join target). See [[../specs/whitelisted-page-auto-tracking]].
- **The 11 legacy seeds** were migrated in as `source='manual'`, `status='approved'`, `product_id=null` for every ad-tool workspace (those with `ad_campaigns` rows).

## Read/written by

- [[../libraries/competitors]] — `loadApprovedCompetitorsForProduct` / `productsWithApprovedCompetitors` (per-product read), `discoverCompetitors` / `promoteWhitelistedPages` (write proposals). `loadApprovedCompetitorSeeds` + `promoteFromCategorySweep` retired 2026-07-12.
- [[../inngest/creative-scout]] — reads approved rows per product; writes whitelisted-page proposals.
- [[../inngest/acquisition-research-cadence]] — writes category-sweep + whitelisted-page proposals in the daily re-scan.
- [[../inngest/competitor-scout]] — the discovery pass writer.
- `src/app/api/ads/competitors` (+ `[id]`) — owner list / discover trigger / approve-reject. The list route resolves `runs_ads_for` (self-FK) → the fronted competitor's `brand` server-side (`runs_ads_for_brand`) so the UI renders "runs ads for {brand}" without a second lookup.
- `src/app/dashboard/marketing/acquisition` (via [[../libraries/acquisition-hub]] `loadHubData`) — the Acquisition Research Hub's Competitor set section renders a `source` badge and, for `source='whitelisted'` rows, the exact `search_keyword` + "runs ads for {brand}" affordance.
- [[../dashboard/research__competitors]] — the owner-facing, product-filtered, read-only browse surface under Research › Competitors (reads the API above; never mutates).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]] · [[../specs/competitor-scout]]
