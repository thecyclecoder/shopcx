# `src/lib/lander-blueprints.ts` — Cleo's blueprint + Carrie's DR-content-store SDK

The chokepoint for [[../tables/lander_blueprints]] AND for Carrie's DR-content store: the ONLY file allowed to write [[../tables/lander_blueprints]], [[../tables/lander_content_gaps]], or the DR columns on [[../tables/product_media]] (`category` / `source` / `caption`). Owns `validateSkeleton`, the build-lifecycle status vocabulary, the categorized `product_media` reader/writer, and the [[../tables/lander_content_gaps]] create/list/resolve helpers. Phase 1 of [[../specs/cleo-lander-blueprint]] + Phase 1 of [[../specs/carrie-dr-content]] (parent: [[../goals/acquisition-research-engine]]).

**North-star (supervisable autonomy):** Cleo (Max's leash) deterministically PROPOSES a blueprint off a worthy [[../tables/research_urls]] teardown when the gap is a whole missing funnel TYPE (Phase 2 — the modify-vs-build-new session); Carrie (dr-content) fills content within the same leash; Ada/Platform's build submission is the human-touch handoff. This file NEVER acts — it's the write chokepoint the agents call through.

## Exports

| Export | Notes |
|---|---|
| `createBlueprint(input)` | INSERT one row. Runs `validateSkeleton` (throws on empty `blocks` / missing `role` or `purpose`) BEFORE the write — a half-formed skeleton never reaches the row (author-spec gate discipline, mirrors [[research-urls]] `setTeardown` / `validateTeardownRecipe`). Defaults status to `content_in_progress` (matches the CHECK constraint's DEFAULT). Returns the freshly-landed `LanderBlueprint` so the caller can enqueue Carrie's [[../tables/agent_jobs]] `dr-content` job carrying the id. |
| `getBlueprint(workspaceId, id)` | Single-row read (workspace-scoped). Returns `null` when the row doesn't exist. |
| `listBlueprints(workspaceId, filter?)` | Filter by `product_id` \| `research_url_id` \| `status` \| `funnel_type`; ordered `created_at DESC`, default limit 200. |
| `hasBlueprintForProductType(workspaceId, productId, funnelType)` | Dedup reader for [[cleo-blueprint]] `runCleoBlueprintSweep` (Phase 1 of [[../specs/cleo-blueprint-product-matching]]) — has this workspace already got a blueprint for the same `(product_id, funnel_type)` pair, in ANY status? A `true` here means the sweep MUST skip creating a duplicate — pairs with the sweep's within-sweep `Set<blueprintDedupKey>` to hold the "AT MOST ONE blueprint per (product, funnel_type)" invariant across BOTH within-sweep and DB-side dedup. |
| `setBlueprintStatus(workspaceId, id, status)` | Advance the build lifecycle — `content_in_progress` → `awaiting_upload` → `content_complete` → `build_submitted` (or → `rejected`). The SDK is the only path, so the vocabulary is enforced here + belt+suspenders in the DB CHECK. |
| `setBlueprintContent(workspaceId, id, content)` | Carrie's copy write — per-block `role` + `copy` (+ optional `assets`). Keeps `skeleton` untouched (that's structure); `content` is the copy layer. Rejects an empty `content.blocks` or a block missing `role` / `copy`. |
| `validateSkeleton(skeleton)` | Exported so one-off scripts / tests can assert a skeleton before storing it. Throws on failure; returns void on pass. |
| `LanderBlueprint` / `LanderBlueprintStatus` / `LanderBlueprintSkeleton` / `LanderBlueprintBlock` / `LanderBlueprintContent` / `LanderBlueprintContentBlock` / `LanderBlueprintFilter` / `CreateBlueprintInput` | Types. |
| `writeCategorizedProductMedia(input)` | Persist a Carrie DR asset (a Nano-Banana-Pro generation or a founder upload) to [[../tables/product_media]] with `category` + `source` + `caption`. UPSERTS on `(workspace_id, product_id, slot, display_order)` so re-running the same slot rewrites the row (mirrors [[product-intelligence]] `seed-tools.saveMedia`). Validates `category` / `source` against the CHECK vocabularies. |
| `listCategorizedProductMedia(workspaceId, productId, filter?)` | Carrie's "do we already have an X for this product?" probe. Filter by `category` \| `source`. Returns only the DR-relevant subset of columns (no responsive-variant bloat). |
| `openContentGap(input)` | Carrie opens one row per real-evidence asset she can't ethically generate (before/after, UGC selfie, testimonial photo, press logo). Description written for the FOUNDER — plain language, no jargon. Routed to Max via [[approval-inbox]] (`ownerFunctionForKind('dr-content')='growth'`). |
| `listContentGaps(workspaceId, filter?)` | Filter by `blueprint_id` \| `status` \| `asset_role`. Drives Carrie's status-transition probe (open-gaps → `awaiting_upload`, zero → `content_complete`) and Max's inbox lane. |
| `resolveContentGap(workspaceId, gapId, resolvedMediaId)` | Founder / operator marks the gap resolved after supplying the real-evidence [[../tables/product_media]] row. Idempotent — resolving again re-points `resolved_media_id`. |
| `REAL_EVIDENCE_CATEGORIES` | `readonly ["before_after", "ugc", "testimonial_photo", "press_logo"]` — the never-fake-a-customer-result set. |
| `ProductMediaCategory` / `ProductMediaSource` / `ProductMediaCategorizedRow` / `WriteCategorizedMediaInput` / `LanderContentGap` / `LanderContentGapAssetRole` / `LanderContentGapStatus` / `OpenContentGapInput` / `ListContentGapsFilter` | Types. |

## `LanderBlueprintSkeleton` shape

The `transferable_pattern` adapted to our benefit tree — the ORDERED blocks to build. Persisted to `lander_blueprints.skeleton` (jsonb). Validated by `validateSkeleton` before every write.

```ts
interface LanderBlueprintBlock {
  role: string;      // "hero" | "intro/proof" | "reason_1" | "offer" | "faq" | …
  purpose: string;   // one-sentence: what this block does for the reader
  levers?: string[]; // Rhea's tagged persuasion primitives this block carries
  notes?: string;    // Cleo's notes — what to preserve from the teardown, what to adapt
}

interface LanderBlueprintSkeleton {
  blocks: LanderBlueprintBlock[]; // ordered top-to-bottom of the new lander
  hypothesis?: string;             // one-sentence hypothesis Cleo is testing
}
```

## `LanderBlueprintContent` shape

Carrie's copy pass. Mirrors `skeleton.blocks` order so a reader can zip. Written by `setBlueprintContent`.

```ts
interface LanderBlueprintContentBlock {
  role: string;                              // matches skeleton.blocks[i].role
  copy: string;                              // headline / body copy
  assets?: { kind: string; ref: string }[];  // image / video URLs, prompt seeds, etc.
}

interface LanderBlueprintContent {
  blocks: LanderBlueprintContentBlock[];
  cta?: string;
}
```

## Build lifecycle vocabulary (`LanderBlueprintStatus`)

Matches the CHECK constraint on `public.lander_blueprints.status`:

- `content_in_progress` — Cleo just landed the row; Carrie's `dr-content` job is queued.
- `awaiting_upload` — Carrie needs assets from ops.
- `content_complete` — every block in `content` is filled; ready for build submit.
- `build_submitted` — the build was handed to Ada/Platform (a [[../tables/spec_phases]] row was authored off this blueprint).
- `rejected` — Cleo (or an owner) killed the blueprint.

## Gotchas

- **Chokepoint discipline.** All writes to [[../tables/lander_blueprints]] + [[../tables/lander_content_gaps]] + the DR columns on [[../tables/product_media]] (`category` / `source` / `caption`) go through this file via `createAdminClient()`. A raw `.from(...).insert|update|upsert` anywhere else skips `validateSkeleton` + the status-vocabulary check + the never-fake-a-customer-result discipline. Mirrors the pattern used by [[research-urls]] / [[specs-table]] / goals-table.
- **Real-evidence categories are the never-fake line.** `REAL_EVIDENCE_CATEGORIES` (`before_after`, `ugc`, `testimonial_photo`, `press_logo`) must NEVER be written via `writeCategorizedProductMedia` with `source: 'generated'`. Not enforced by a DB CHECK — it's caller discipline in Carrie's [[builder-worker]] `runDrContentJob` (never routing a generated asset to a real-evidence category). If you're tempted to bypass this, that's a spec-violation.
- **`skeleton` ≠ `content`.** `skeleton` is STRUCTURE (blocks + levers); `content` is COPY. `createBlueprint` + `setBlueprintContent` write DIFFERENT columns for a reason — never conflate.
- **`funnel_type` is free-text.** The vocabulary is Rhea's `TeardownRecipe.funnel_type` — extending it is a spec change over there, not a validation here.
- **`created_by` is free-text.** Mirrors [[research-urls]] `classified_by` — `'cleo'` for the deterministic session, operator email for a manual override.

## Callers

- **[[builder-worker]] (Phase 2 — Cleo's modify-vs-build-new session)** — reads [[research-urls]] `listNewTeardowns`, matches each teardown to a category-appropriate product via [[cleo-blueprint]] `matchProductToTeardown` (null → skip — see [[../specs/cleo-blueprint-product-matching]] Phase 1), diffs against Cleo's [[../tables/storefront_experiments]] for that product, and — GATED by `hasBlueprintForProductType` + a within-sweep dedup Set — calls `createBlueprint` on a whole-missing-funnel-type gap. Then deterministically enqueues a `dr-content` [[../tables/agent_jobs]] job carrying the blueprint id and calls [[research-urls]] `markTeardownReviewed`.
- **Carrie (`dr-content`)** — reads `getBlueprint` for the skeleton + `listCategorizedProductMedia` for the existing DR asset store; per generatable slot calls `writeCategorizedProductMedia` after a [[gemini]] `generateNanoBananaProCombine` returns; per real-evidence slot with no existing row calls `openContentGap`. When copy is done she calls `setBlueprintContent`, then advances `setBlueprintStatus` to `content_complete` (zero open gaps) or `awaiting_upload` (any open gap) — the transition is driven by `listContentGaps(workspaceId, { blueprint_id, status: 'open' })`.
- **Owner-facing blueprints panel (Phase 3 UI)** — `listBlueprints` for the queue view, `getBlueprint` for the detail.

## Related

[[../specs/cleo-lander-blueprint]] · [[../specs/cleo-blueprint-product-matching]] · [[../specs/carrie-dr-content]] · [[../specs/rhea-teardown-recipe]] · [[../tables/lander_blueprints]] · [[../tables/lander_content_gaps]] · [[../tables/product_media]] · [[../tables/research_urls]] · [[../tables/products]] · [[../tables/agent_jobs]] · [[../functions/growth]] · [[../functions/platform]] · [[research-urls]] · [[approval-inbox]] · [[gemini]] · [[../goals/acquisition-research-engine]]
