# `src/lib/lander-blueprints.ts` — Cleo's teardown → build-new blueprint SDK

The chokepoint for [[../tables/lander_blueprints]]: the ONLY file allowed to write the table. Owns `validateSkeleton`, the build-lifecycle status vocabulary, and the read helpers Carrie / the owner panel consume. Phase 1 of [[../specs/cleo-lander-blueprint]] (parent: [[../goals/acquisition-research-engine]]).

**North-star (supervisable autonomy):** Cleo (Max's leash) deterministically PROPOSES a blueprint off a worthy [[../tables/research_urls]] teardown when the gap is a whole missing funnel TYPE (Phase 2 — the modify-vs-build-new session); Carrie (dr-content) fills content within the same leash; Ada/Platform's build submission is the human-touch handoff. This file NEVER acts — it's the write chokepoint the agents call through.

## Exports

| Export | Notes |
|---|---|
| `createBlueprint(input)` | INSERT one row. Runs `validateSkeleton` (throws on empty `blocks` / missing `role` or `purpose`) BEFORE the write — a half-formed skeleton never reaches the row (author-spec gate discipline, mirrors [[research-urls]] `setTeardown` / `validateTeardownRecipe`). Defaults status to `content_in_progress` (matches the CHECK constraint's DEFAULT). Returns the freshly-landed `LanderBlueprint` so the caller can enqueue Carrie's [[../tables/agent_jobs]] `dr-content` job carrying the id. |
| `getBlueprint(workspaceId, id)` | Single-row read (workspace-scoped). Returns `null` when the row doesn't exist. |
| `listBlueprints(workspaceId, filter?)` | Filter by `product_id` \| `research_url_id` \| `status` \| `funnel_type`; ordered `created_at DESC`, default limit 200. |
| `setBlueprintStatus(workspaceId, id, status)` | Advance the build lifecycle — `content_in_progress` → `awaiting_upload` → `content_complete` → `build_submitted` (or → `rejected`). The SDK is the only path, so the vocabulary is enforced here + belt+suspenders in the DB CHECK. |
| `setBlueprintContent(workspaceId, id, content)` | Carrie's copy write — per-block `role` + `copy` (+ optional `assets`). Keeps `skeleton` untouched (that's structure); `content` is the copy layer. Rejects an empty `content.blocks` or a block missing `role` / `copy`. |
| `validateSkeleton(skeleton)` | Exported so one-off scripts / tests can assert a skeleton before storing it. Throws on failure; returns void on pass. |
| `LanderBlueprint` / `LanderBlueprintStatus` / `LanderBlueprintSkeleton` / `LanderBlueprintBlock` / `LanderBlueprintContent` / `LanderBlueprintContentBlock` / `LanderBlueprintFilter` / `CreateBlueprintInput` | Types. |

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

- **Chokepoint discipline.** All writes go through this file via `createAdminClient()`. A raw `.from('lander_blueprints').insert|update|upsert` anywhere else skips `validateSkeleton` + the status-vocabulary check. Mirrors the pattern used by [[research-urls]] / [[specs-table]] / goals-table.
- **`skeleton` ≠ `content`.** `skeleton` is STRUCTURE (blocks + levers); `content` is COPY. `createBlueprint` + `setBlueprintContent` write DIFFERENT columns for a reason — never conflate.
- **`funnel_type` is free-text.** The vocabulary is Rhea's `TeardownRecipe.funnel_type` — extending it is a spec change over there, not a validation here.
- **`created_by` is free-text.** Mirrors [[research-urls]] `classified_by` — `'cleo'` for the deterministic session, operator email for a manual override.

## Callers

- **[[builder-worker]] (Phase 2 — Cleo's modify-vs-build-new session)** — reads [[research-urls]] `listNewTeardowns`, diffs against our funnel + Cleo's [[../tables/storefront_experiments]], and calls `createBlueprint` on a whole-missing-funnel-type gap. Then deterministically enqueues a `dr-content` [[../tables/agent_jobs]] job carrying the blueprint id and calls [[research-urls]] `markTeardownReviewed`.
- **Carrie (`dr-content`)** — reads `getBlueprint` for the skeleton, produces per-block copy, writes via `setBlueprintContent`, then advances `setBlueprintStatus` to `content_complete` (or `awaiting_upload` while she waits on assets).
- **Owner-facing blueprints panel (Phase 3 UI)** — `listBlueprints` for the queue view, `getBlueprint` for the detail.

## Related

[[../specs/cleo-lander-blueprint]] · [[../specs/rhea-teardown-recipe]] · [[../tables/lander_blueprints]] · [[../tables/research_urls]] · [[../tables/products]] · [[../tables/agent_jobs]] · [[../functions/growth]] · [[../functions/platform]] · [[research-urls]] · [[../goals/acquisition-research-engine]]
