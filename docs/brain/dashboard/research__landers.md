# dashboard/research/landers

The owner-facing window onto **Rhea**'s URL sensor output — the landers she found + the teardowns she wrote. Reads [[../tables/research_urls]] (list + each row's structured `teardown` recipe + `capture_ref` → the chaptered mobile shots in the private `research-shots` bucket) and renders them as a real teardown board so Growth can operate against Rhea's output without leaving the app. Growth operates; Ada / Platform builds — sibling of [[research__competitors]] under the owner-gated Research section in [[../../src/app/dashboard/sidebar]].

**Route:** `/dashboard/research/landers` (client, owner-only) · detail at `/dashboard/research/landers/[id]`
**Sidebar:** **Research** section (owner-only) → **Landers**, placed directly below [[research__competitors|Competitors]] and above [[research__teardowns|Teardowns]] (the sibling curated gallery — renamed from the legacy 'Lander Teardowns').

## Surfaces

### The list — `/dashboard/research/landers`

A table of the workspace's captured landers, **worthiest-first** (highest `ad_count`, matching the same "spend = importance" signal the [[../inngest/research-sensor]] claim uses). Each row carries:

- **Brand** — `research_urls.brand` (Rhea's `seed_keyword` bind at sync time — see [[../libraries/research-urls]] § sync).
- **URL** — the normalized `url` (short-host + path), linking out to the live page, with the row's `domain` beneath.
- **Classification badge** — `advertorial` · `quiz` · `generic_pdp` · `homepage` · `spam` · `unviewable` · `excluded` · `checkout` (Rhea's classify write or the deterministic sync-time gate).
- **Ad count** — the spend signal (creative_skeletons count for this destination).
- **Verdict pill** — `worthy` · `not_worthy` · `unreviewed` (`teardown_verdict`).
- **Open teardown →** — an action button, only on rows where the API's projected `has_teardown = true` (i.e. `teardown IS NOT NULL`). Rows without a teardown fall back to a plain **Details** link (still opens the detail page — the classification + rationale live there too).

Filters: **classification** and **verdict** dropdowns, forwarded as `?classification=` / `?verdict=` to the API. Header counter shows total + how many carry a teardown.

### The teardown board — `/dashboard/research/landers/[id]`

Rhea's structured `TeardownRecipe` ([[../libraries/research-urls]]) rendered as a **funnel-teardown board**, alongside the captured mobile screenshots so the recipe sits next to the real page:

- **Header** — brand + short URL + classification badge + verdict pill + `ad_count` + `first_seen`–`last_seen` range. The row's `rationale` (Rhea's one-sentence citation) is quoted just below.
- **Funnel type + strategy** — the `funnel_type` (e.g. `advertorial-listicle`) and the one-sentence `strategy` summary.
- **Funnel architecture** — the ordered `architecture[]` (`hero → intro → offer → faq`) as a left-to-right chapter flow, each chapter carrying its `chapter_role` + `purpose`.
- **Reason sequence** — `reason_sequence[]` (populated for listicle-style landers) rendered as an ordered list showing the emotion→logic ordering; each entry stamped with an **emotion** or **logic** appeal pill.
- **Levers** — tagged chips, one per `levers[]` entry, with the concrete `evidence` Rhea saw. Distinct color per lever from the stable vocabulary (`authority` · `social_proof` · `ugc` · `urgency` · `price_anchor` · `risk_reversal` · `value_stack` · `objection_handling` · `specificity` · `bandwagon` · `choice_simplicity`).
- **Offer anatomy** — `offer.discount` · `bundle` · `bonuses` · `guarantee` · `urgency` · `options` grid.
- **Transferable pattern** — the product-agnostic skeleton — how the pattern would port to a Superfoods lander.
- **Captured chapters** — the mobile chapter filmstrip: one `<img>` per chapter under `capture_ref` in the private `research-shots` bucket, each rendered via a short-lived signed URL from [[../libraries/research-urls]] `signResearchShot`.

**Graceful states:**

- **No teardown yet** — Rhea only writes a structured recipe for `worthy` landers. A row without a teardown shows its classification + rationale + the captured chapters (when a `capture_ref` exists) instead of the board.
- **Unviewable** — Rhea's headless capture returned `unviewable` (bot-block or persistent nav failure after retries). The board is replaced with an amber callout that notes the capture couldn't be rendered.

This surface is **read-only** — every WRITE to [[../tables/research_urls]] goes through the [[../libraries/research-urls]] chokepoint (Rhea's classify pass, the sync, or Cleo's growth-review watermark). Nothing on this page mutates the row.

## Data source

- `GET /api/research/landers` (`src/app/api/research/landers/route.ts`, owner-gated) → [[../libraries/research-urls]] `listResearchUrls(workspaceId, filter)` projected to a list-view shape (`{ id, url, brand, domain, classification, ad_count, teardown_verdict, first_seen, last_seen, has_teardown }`, `ad_count` DESC). Accepts optional `?classification=` / `?verdict=` filters.
- `GET /api/research/landers/[id]` (`src/app/api/research/landers/[id]/route.ts`, owner-gated) → [[../libraries/research-urls]] `getResearchUrl(workspaceId, id)` for the full row (including the `teardown` recipe + `rationale` + `capture_ref`) paired with `listResearchShotChapters(capture_ref)` for the `chapters[]` list. Each chapter carries a `signed_url` from `signResearchShot()` — the ONLY read path for a stored chapter (the bucket is private).

Both routes 403 for a non-owner (`role !== 'owner'` → `Forbidden`), mirroring the sibling `/api/ads/lander-teardowns` gate.

## Relationship to `/dashboard/research/teardowns`

**Landers** is the broad list — every classified URL Rhea has seen, filterable by classification + verdict. The sibling **[[research__teardowns|Teardowns]]** surface is the curated subset — only the rows carrying a structured `TeardownRecipe` — paired with the founder-approved Showcase HTML board (`/showcase/tools/teardowns/examples/[id]`) for each. Both read the SAME [[../tables/research_urls]] via the [[../libraries/research-urls]] chokepoint. Together they replace the OLDER `lander_snapshots` / funnel-teardown-scout system that predated Rhea — the legacy `/api/ads/lander-teardowns` funnel-filmstrip page is superseded.

## Related

[[../tables/research_urls]] · [[../libraries/research-urls]] (`signResearchShot`, `listResearchShotChapters`, `getResearchUrl`, `RESEARCH_SHOTS_BUCKET`) · [[../specs/rhea-url-sensor]] · [[../specs/rhea-teardown-recipe]] · [[../specs/rhea-research-automation]] · [[../inngest/research-sensor]] · [[../recipes/lander-capture]] · [[../recipes/lander-teardown]] · [[../functions/growth]] · [[../functions/platform]] · [[../goals/acquisition-research-engine]] · [[research__competitors]] · [[research__teardowns]] (curated gallery + Showcase board)
