# lander_blueprints

Cleo's teardown → build-new blueprint entity. One row per (product × source teardown) pair Cleo has decided is a WHOLE-MISSING-FUNNEL-TYPE case (not a single reversible lever — those still route to her existing bandit path, unchanged). The BRIDGE from Rhea's research ([[research_urls]].teardown) to Ada/Platform's build queue. See [[../specs/cleo-lander-blueprint]] · [[../goals/acquisition-research-engine]] · [[../functions/growth]].

**North-star (supervisable autonomy):** Cleo (Max's leash) deterministically PROPOSES a blueprint off a worthy teardown; Carrie (dr-content) fills content within the same leash; the build submission is where Ada/Platform's build discipline takes over. Every status transition + rationale is auditable — never a silent proxy-optimizer.

**Design:** a distinct ENTITY (not a flag on [[research_urls]]) because it carries a build lifecycle.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `product_id` | `uuid` | — | → [[products]].id · ON DELETE CASCADE. The lander TARGET — the product whose benefit tree matches the teardown's category (e.g. Amazing Coffee for a superfood-coffee teardown). |
| `research_url_id` | `uuid` | ✓ | → [[research_urls]].id · ON DELETE SET NULL. The SOURCE teardown Cleo diffed against our funnel. Nullable so a purged research_urls row leaves the blueprint in place (its skeleton was copied inline). |
| `funnel_type` | `text` | — | Carried from the source teardown (e.g. `advertorial-listicle`, `quiz`). Vocabulary is [[../libraries/research-urls]] `TeardownRecipe.funnel_type` — free-text on purpose so extending it is a spec change over there, not a migration here. |
| `skeleton` | `jsonb` | — | The `transferable_pattern` ADAPTED to our benefit tree — the ordered blocks to build (each carrying which levers it implements). Shape = `{ blocks: [{ role, purpose, levers?, notes? }], hypothesis? }`. Structure only; the copy lives in `content`. |
| `status` | `text` | — | default `'content_in_progress'` · CHECK ∈ `content_in_progress` \| `awaiting_upload` \| `content_complete` \| `build_submitted` \| `rejected`. Build lifecycle — see below. |
| `rationale` | `text` | ✓ | Cleo's citation — the WHY behind picking build-new over modify-existing for this teardown/product pair. Kept next to the row so the decision is auditable when a reviewer opens the blueprint later. |
| `content` | `jsonb` | ✓ | Carrie's copy pass, block-by-block. Shape = `{ blocks: [{ role, copy, assets?: [{kind, ref}] }], cta? }`. Mirrors `skeleton.blocks` order so a reader can zip them. Null until Carrie writes. |
| `created_by` | `text` | ✓ | Free-text; `'cleo'` for the deterministic session, operator email on manual authoring. Mirrors [[research_urls]] `classified_by` convention. |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()`, auto-bumped by `lander_blueprints_touch_updated_at` on any UPDATE. |

**Indexes:** `(workspace_id, product_id)` — browse-by-product for the owner's per-PDP blueprints panel · `(workspace_id, status)` — Cleo/Carrie work queues · `(workspace_id, research_url_id)` — has-this-teardown-already-produced-a-blueprint lookup.

## Build lifecycle (`status`)

| Status | Meaning |
|---|---|
| `content_in_progress` | Cleo just landed the row; Carrie's `dr-content` [[agent_jobs]] job is queued. |
| `awaiting_upload` | Carrie needs assets (hero image, testimonials, ...) from ops. |
| `content_complete` | Every block in `content` is filled; ready for build submit. |
| `build_submitted` | The build was handed to Ada/Platform (a [[spec_phases]] row was authored off this blueprint). |
| `rejected` | Cleo (or an owner) killed the blueprint — a rationale change re-surfaced the source teardown as a modify-existing case. |

## `skeleton` shape (jsonb)

The `transferable_pattern` adapted to our benefit tree — the ORDERED blocks to build. Written by [[../libraries/lander-blueprints]] `createBlueprint`. Validation is enforced in the SDK (`validateSkeleton`): empty `blocks` array or a block missing `role` / `purpose` is rejected.

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

## `content` shape (jsonb)

Carrie's copy pass. Mirrors `skeleton.blocks` order so a reader can zip. Written by [[../libraries/lander-blueprints]] `setBlueprintContent`.

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

## RLS

- `lander_blueprints_select` — `authenticated` read where `workspace_id` ∈ caller's [[workspace_members]].
- `lander_blueprints_service` — `service_role` full. All writes go through `createAdminClient()` via [[../libraries/lander-blueprints]].

## Gotchas

- **All writes go through [[../libraries/lander-blueprints]].** A raw `.from('lander_blueprints').insert|update|upsert` anywhere else bypasses `validateSkeleton` + the status-vocabulary check. Chokepoint mirrors [[research_urls]] / [[specs-table]] / goals-table.
- **`skeleton` ≠ `content`.** `skeleton` is STRUCTURE (blocks + levers); `content` is COPY. Cleo writes the first, Carrie writes the second — they should never be edited together.
- **Single-lever gaps do NOT create a blueprint.** Cleo's blueprint decision is the WHOLE-MISSING-FUNNEL-TYPE branch only. A reversible single-lever gap routes to her existing bandit path (unchanged) — see [[../specs/cleo-lander-blueprint]] Phase 2 for the decision logic.
- **`research_url_id` is nullable + SET NULL on delete.** The blueprint's skeleton is a COPY of the teardown's `transferable_pattern` — losing the source row doesn't invalidate the blueprint (it just loses the pointer back).

## Written by

[[../libraries/lander-blueprints]] (`createBlueprint`, `setBlueprintStatus`, `setBlueprintContent`) ← Cleo's blueprint decision in [[../libraries/builder-worker]] (Phase 2 — the modify-vs-build-new session, off `listNewTeardowns`).

## Read by

[[../libraries/lander-blueprints]] (`listBlueprints`, `getBlueprint`) ← Carrie's `dr-content` [[agent_jobs]] worker (loads the skeleton to fill copy per block) + the owner-facing blueprints panel (Phase 3 UI).

## Related

[[../specs/cleo-lander-blueprint]] · [[../specs/rhea-teardown-recipe]] · [[../specs/rhea-research-automation]] · [[../goals/acquisition-research-engine]] · [[research_urls]] · [[products]] · [[agent_jobs]] · [[../functions/growth]] · [[../functions/platform]] · [[../libraries/research-urls]]
