# lander_snapshots

Per-chapter mobile snapshots of competitor landing pages **and ours** — the capture half of [[../specs/landing-page-scout]] (M3 of [[../goals/acquisition-research-engine]]). One row per captured lander; the per-chapter screenshots live in `chapters` jsonb (paths into the private `lander-shots` Storage bucket). Ours pairs each chapter with that chapter's funnel stats. Written by the box script `scripts/landing-page-snapshot.ts` (Playwright); read by the vision gap-analysis ([[../libraries/landing-page-scout]] `analyzeLanderGaps`).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `product_id` | `uuid` | ✓ | The product this lander is compared for → [[products]].id · ON DELETE SET NULL |
| `competitor_id` | `uuid` | ✓ | The competitor this lander belongs to → [[competitors]].id · ON DELETE SET NULL. Null when `is_ours`. |
| `is_ours` | `boolean` | — | default: `false` · TRUE for our storefront lander |
| `brand` | `text` | ✓ | Display handle (`'us'` for ours, else the competitor brand) |
| `url` | `text` | — | The exact lander URL captured |
| `source` | `text` | — | default: `'competitor_pdp'` · CHECK ∈ `ad_destination` \| `competitor_pdp` \| `our_lander` |
| `viewport` | `text` | — | default: `'mobile'` |
| `status` | `text` | — | default: `'captured'` · CHECK ∈ `captured` \| `blocked` \| `failed`. Blocked/failed are logged + skipped by analysis, never fatal. |
| `chapters` | `jsonb` | — | default: `'[]'` · array of `{ index, label, screenshot_path, avg_dwell_ms?, view_to_cta_pct?, reach_sessions? }` |
| `error` | `text` | ✓ | Bot-block / failure reason (for `blocked`/`failed`) |
| `funnel_step` | `int` | — | default: `0` · 0 = entry lander; each funnel-follow step increments ([[../specs/funnel-teardown-scout]] Phase 1) |
| `funnel_root_url` | `text` | ✓ | The entry lander URL that groups all steps of one funnel walk. Null for legacy pre-funnel-follow rows. |
| `cta_target_url` | `text` | ✓ | THIS step's extracted primary CTA — the most-frequent outbound same-or-related-brand URL on the rendered page (Erth: /women50 → erthlabs.co/products/superfoodcoffee-starterkit ×10 vs ×1 footer links). Null when no qualifying outbound target exists. |
| `page_type` | `text` | ✓ | Vision-inferred lander archetype (e.g. `advertorial`, `single-bundle PDP`, `multi-tier PDP`, `quiz`, `editorial`) — [[../specs/funnel-teardown-scout]] Phase 2. Null until the deconstruction runs. |
| `skeleton` | `jsonb` | ✓ | The page-type-aware structural skeleton: `{ offer_structure, big_promise, beats[{beat,does,chapters[]}], tactics[] }`. Written by [[../libraries/landing-page-scout]] `deconstructLander`. Null until the deconstruction runs. |
| `captured_at` | `timestamptz` | ✓ | |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

**Indexes:** `(workspace_id, product_id, created_at desc)`, `(workspace_id, is_ours, created_at desc)`, `(workspace_id, funnel_root_url, funnel_step)` — the analysis loads the latest captured competitor + our snapshots; the funnel index orders all steps of one funnel.

## Foreign keys

**Out (this → others):**
- `workspace_id` → [[workspaces]].`id`
- `product_id` → [[products]].`id`
- `competitor_id` → [[competitors]].`id`

## Sourcing the landers (the bridge)

`chapters[].screenshot_path` are keys into the **private `lander-shots` bucket** (signed-URL access only). Competitor URLs come from [[../specs/ad-creative-scout]]'s captured ad destinations (highest signal — the exact page they drive paid traffic to) + [[competitors]]' canonical `pdp_urls` (breadth). Our URLs are the storefront PDP. See [[../libraries/landing-page-scout]] `loadLanderTargets`.

## Gotchas

- **Append-only per run** — there's no unique key; each capture run inserts fresh rows. Queries take the latest by `created_at`.
- **Ours' funnel stats are paired in at capture time** from [[storefront_events]] (StorefrontChapterTracker), keyed by the `data-section` chapter label.
- The capture is a **box script**, never serverless — Playwright can't run in Inngest/Vercel.
- **Funnel walk is bounded** to `DEFAULT_FUNNEL_DEPTH=3` (entry → next → next-next). Checkout capture is Tool 5 and out of scope. Each step is its own row; steps of one walk share `funnel_root_url` with incrementing `funnel_step`. A step that fails to load is written as `status='blocked'|'failed'` and stops that branch — never a hard failure. Dedup on URL prevents a CTA loop from re-capturing a page in one run.
- **Only outbound same-or-related-brand CTAs are followed** — never an arbitrary third party. See [[../libraries/landing-page-scout]] `extractCtaTarget`.
- **Skeleton is per-step and idempotent** — `deconstructLander` skips a snapshot that already has both `page_type` and `skeleton`, so a re-run doesn't re-spend Opus tokens. Vision cost is bounded to `DECONSTRUCT_MAX_CHAPTERS=8` chapters per step. Token spend is logged via [[../libraries/ai-usage]] with `purpose='lander-skeleton-vision'`.

## Related

[[../specs/landing-page-scout]] · [[../libraries/landing-page-scout]] · [[../inngest/landing-page-scout]] · [[lander_recommendations]] · [[competitors]] · [[storefront_events]]
