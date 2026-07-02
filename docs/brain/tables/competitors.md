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
| `source` | `text` | — | default: `'manual'` · CHECK ∈ `llm` \| `category_sweep` \| `manual` |
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
- **The 11 legacy seeds** were migrated in as `source='manual'`, `status='approved'`, `product_id=null` for every ad-tool workspace (those with `ad_campaigns` rows).

## Read/written by

- [[../libraries/competitors]] — `loadApprovedCompetitorSeeds` (read), `discoverCompetitors` / `promoteFromCategorySweep` (write proposals).
- [[../inngest/creative-finder]] — reads approved seeds; writes category-sweep proposals.
- [[../inngest/competitor-scout]] — the discovery pass writer.
- `src/app/api/ads/competitors` (+ `[id]`) — owner list / discover trigger / approve-reject.
- [[../dashboard/research__competitors]] — the owner-facing, product-filtered, read-only browse surface under Research › Competitors (reads the API above; never mutates).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]] · [[../specs/competitor-scout]]
