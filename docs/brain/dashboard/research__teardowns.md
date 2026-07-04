# dashboard/research/teardowns

The owner-facing curated gallery of **Rhea**'s successful teardowns — the ones with a structured recipe worth studying — plus the founder-approved **HTML board** on the Showcase for each. Complements [[research__landers]] (the broader list of every classified URL) with just the curated set. Reads [[../tables/research_urls]] via [[../libraries/research-urls]] `listResearchUrls({ has_teardown: true })`; the Showcase board reads one row via `getResearchUrlById` + `listResearchShotChapters` + `signResearchShot`. Growth operates; Ada / Platform builds — sibling of [[research__competitors]] + [[research__landers]] under the owner-gated Research section in [[../../src/app/dashboard/sidebar]]. **Supersedes the legacy `lander_snapshots` teardowns surface** (the funnel-filmstrip page that used to live here and read `/api/ads/lander-teardowns`).

**Sidebar rename:** the item was **'Lander Teardowns'** and is now **'Teardowns'** (retains the same href `/dashboard/research/teardowns`), placed after [[research__competitors|Competitors]] / [[research__landers|Landers]] in the Research section.

## Surfaces

### The list — `/dashboard/research/teardowns`

A curated table of the workspace's **successful** teardowns — every `research_urls` row where `teardown IS NOT NULL` (i.e. Rhea judged the lander `worthy` and wrote a structured `TeardownRecipe`), worthiest-first (`ad_count` DESC, the same spend-as-importance signal the sibling Landers list uses). Each row carries:

- **Brand** — `research_urls.brand`.
- **URL** — the normalized `url` (short-host + path), linking out to the live page, with the row's `domain` beneath.
- **Funnel type** — the recipe's `funnel_type` chip (e.g. `advertorial-listicle`, `quiz`, `generic_pdp`), teal-accented.
- **Ad count** — the spend signal (`ad_count`).
- **Captured** — `last_seen` formatted as a short date.
- **View HTML →** — a teal action button linking to the Showcase board at `/showcase/tools/teardowns/examples/[id]` (below).

Route is `"use client"`; owner-gated (a non-owner sees a one-line "owner-only" copy line). Suspense boundary lives in the shared `src/app/dashboard/research/layout.tsx`.

### The Showcase board — `/showcase/tools/teardowns/examples/[id]`

The founder-approved battle-tested HTML view, **server-rendered** from the row's `teardown` recipe + `capture_ref` chapters. Lives under the existing [[../lifecycles/showcase]] section so it inherits the `/showcase/unlock` password gate (in `src/proxy.ts`) + the `src/app/showcase/layout.tsx` chrome/theme + the scoped `.showcase-root` light/dark token set. Teal accent (Rhea's) with the analysis layer in mono and the narrative layer in serif.

The board:

- **Masthead** — brand + source URL + the recipe's one-sentence `strategy` line + a stat strip (`funnel_type` / chapter count / reason count / lever count / offer options).
- **Funnel-beat ribbon** — the ordered `architecture[]` rendered as a horizontal `beat 1 → beat 2 → …` ribbon, each carrying its `chapter_role` + `purpose`.
- **Lever inventory** — one card per `levers[]` entry: the tag pill (from the stable vocabulary `authority` · `social_proof` · `ugc` · `urgency` · `price_anchor` · `risk_reversal` · `value_stack` · `objection_handling` · `specificity` · `bandwagon` · `choice_simplicity`) + the concrete `evidence` Rhea saw.
- **Chapter walk** — **every chapter in order, no gaps** — each chapter's signed screenshot next to its analysis: `chapter_role` + `purpose` from `architecture[]` at the same index, plus (when populated) that reason's `benefit` + `mechanism` + `appeal` (emotion / logic) from `reason_sequence[]`.
- **Offer anatomy** — `offer.discount` · `bundle` · `bonuses` · `guarantee` · `urgency` · `options` grid.
- **Build skeleton** — the recipe's `transferable_pattern` rendered as a mono block, with each `architecture` role tagged as a component and any `reason` / `beat` / `item` role marked as a `× N` repeat unit (no images — this is the product-agnostic scaffold).

**Graceful states:**

- **Missing `capture_ref`** — the recipe board still renders. The chapter walk falls back to the architecture roles and each panel shows a `no capture` placeholder instead of a signed shot.
- **Missing row or no `teardown`** — `notFound()` (a UUID for a row without a recipe won't render a broken board).

The board is **read-only** — every WRITE to [[../tables/research_urls]] goes through the [[../libraries/research-urls]] chokepoint.

## Data sources

- **List page** — `GET /api/research/teardowns` (`src/app/api/research/teardowns/route.ts`, owner-gated) → [[../libraries/research-urls]] `listResearchUrls(workspaceId, { has_teardown: true, limit: 500 })` projected to a list-view shape (`{ id, url, brand, domain, funnel_type, ad_count, captured_at, showcase_href }`). 403 for a non-owner (`role !== 'owner'`).
- **Showcase board** — the page reads the row directly on the server via [[../libraries/research-urls]] `getResearchUrlById(id)` (workspace-agnostic — the Showcase carries no workspace context; the row is looked up by uuid alone under the password gate) paired with `listResearchShotChapters(capture_ref)` for the ordered chapter list. Each chapter's `signed_url` comes from **`signResearchShot(path, ttlSec)`** — the ONLY read path for a stored chapter (the `research-shots` bucket is private). No API route — the server component fetches directly.

## `signResearchShot` — the private-bucket signer

Lives in [[../libraries/research-urls]]. Takes a `path` under the private `research-shots` bucket + an optional `ttlSec` and returns a short-lived signed URL (or `null` on any signing failure — the caller renders a placeholder). Same shape as `signLanderShot` in [[../libraries/landing-page-scout]] but for Rhea's capture manifest. Both the Showcase board and the sibling [[research__landers]] detail page rely on it — a stored chapter is never linked directly, only signed on demand.

## Relationship to sibling surfaces

- **Complements** [[research__landers]] — the broader Landers list surfaces every classified URL (worthy + not_worthy + unreviewed, plus a classification/verdict filter). **Teardowns** is the strict subset with a structured recipe — the ones worth opening the founder-approved HTML board for.
- **Supersedes the legacy `lander_snapshots` teardowns surface** — the older funnel-filmstrip page that used to live at `/dashboard/research/teardowns` and read `/api/ads/lander-teardowns`. That whole system predates Rhea; the new list + Showcase board replace it. Note the in-code `SUPERSEDES` comment at the top of `src/app/dashboard/research/teardowns/page.tsx`.

## Files touched

- `src/app/dashboard/research/teardowns/page.tsx` — the client list page (fully rewritten from the legacy funnel-filmstrip view).
- `src/app/api/research/teardowns/route.ts` — the owner-gated list reader.
- `src/app/showcase/tools/teardowns/examples/[id]/page.tsx` — the server-rendered Showcase board.
- `src/app/showcase/tools/teardowns/examples/[id]/layout.tsx` — Suspense boundary for the cacheComponents rule.
- `src/lib/research-urls.ts` — added `has_teardown` filter to `listResearchUrls` + `getResearchUrlById(id)` (workspace-agnostic reader for the Showcase board).
- `src/app/dashboard/sidebar.tsx` — renamed the item `Lander Teardowns` → `Teardowns` (comment updated).

## Related

[[../tables/research_urls]] · [[../libraries/research-urls]] (`signResearchShot`, `listResearchShotChapters`, `getResearchUrlById`, `listResearchUrls({ has_teardown })`, `RESEARCH_SHOTS_BUCKET`) · [[research__landers]] · [[research__competitors]] · [[../lifecycles/showcase]] · [[../specs/rhea-url-sensor]] · [[../specs/rhea-teardown-recipe]] · [[../specs/rhea-research-automation]] · [[../inngest/research-sensor]] · [[../recipes/lander-capture]] · [[../recipes/lander-teardown]] · [[../functions/growth]] · [[../functions/platform]] · [[../goals/acquisition-research-engine]]
