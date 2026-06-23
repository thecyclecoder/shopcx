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
| `captured_at` | `timestamptz` | ✓ | |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

**Indexes:** `(workspace_id, product_id, created_at desc)`, `(workspace_id, is_ours, created_at desc)` — the analysis loads the latest captured competitor + our snapshots.

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

## Related

[[../specs/landing-page-scout]] · [[../libraries/landing-page-scout]] · [[../inngest/landing-page-scout]] · [[lander_recommendations]] · [[competitors]] · [[storefront_events]]
