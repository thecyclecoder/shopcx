# research_urls

Rhea's URL sensor — one row per distinct ad-scout destination for a workspace. The sensor everything downstream (Rhea's Phase 2 capture+classify loop, Cleo's gap analysis, the Content-Agent handoff) reads. Written by [[../libraries/research-urls]] `syncResearchUrlsFromCreatives` off the [[../inngest/creative-finder]] sweep + (Phase 2) Rhea's classification. See [[../specs/rhea-url-sensor]] · [[../goals/acquisition-research-engine]].

**North-star (supervisable autonomy):** the sync proposes rows (`teardown_verdict='unreviewed'`); Rhea classifies; an owner (Growth) reviews. Rhea never acts.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `url` | `text` | — | The **normalized** destination URL — lower-cased host, query + hash stripped, no trailing slash on non-root paths. The dedup key inside the workspace. |
| `domain` | `text` | — | Bare host (e.g. `learn.erthlabs.co`), extracted from `url`. Read-path browse index. |
| `brand` | `text` | ✓ | Best-effort brand handle — the first non-null `creative_skeletons.seed_keyword` seen for this URL. `null` when the sync couldn't attribute one. |
| `competitor_id` | `uuid` | ✓ | → [[competitors]].id · ON DELETE SET NULL. Null until a later join backfills it. |
| `source` | `text` | — | default `'ad_scout'`. Phase 1 only produces `ad_scout` (from [[creative_skeletons]]); left free-text so `competitor_pdp` / `our_lander` can land later without a migration. |
| `ad_count` | `int` | — | default `0`. Count of [[creative_skeletons]] rows pointing at this URL — the repetition signal Cleo's gap analysis reads. |
| `first_seen` | `timestamptz` | ✓ | Earliest AdLibrary `first_seen` across the collapsed skeletons. |
| `last_seen` | `timestamptz` | ✓ | Latest AdLibrary `last_seen` across the collapsed skeletons. |
| `classification` | `text` | ✓ | CHECK ∈ `advertorial` \| `quiz` \| `generic_pdp` \| `homepage` \| `spam` \| `unviewable`. Vocab reuses the [[../libraries/landing-page-scout]] `page_type` labels plus the two failure cases. Null until Phase 2's Rhea pass classifies. |
| `teardown_verdict` | `text` | — | default `'unreviewed'` · CHECK ∈ `worthy` \| `not_worthy` \| `unreviewed`. Phase 1 always writes `unreviewed`; Phase 2 flips based on Rhea's rationale. |
| `rationale` | `text` | ✓ | Rhea's one-sentence citation of what she saw (why worthy / not_worthy). Null on `unreviewed`. |
| `capture_ref` | `text` | ✓ | Pointer to Phase 2's capture bundle (e.g. `lander-shots` bucket prefix). Null until Phase 2 captures. |
| `classified_at` | `timestamptz` | ✓ | When `classification` was set. |
| `classified_by` | `text` | ✓ | `'rhea'` for the box classifier; operator email on manual override. Free-text on purpose. |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()`, auto-bumped by `research_urls_touch_updated_at` on any UPDATE. |

**Unique:** `(workspace_id, url)` — the idempotent upsert key; re-running the sync updates `ad_count` / `last_seen` in place.

**Indexes:** `(workspace_id, domain)`, `(workspace_id, teardown_verdict)` — browse-by-domain + Rhea's queue-by-verdict.

## RLS

- `research_urls_select` — `authenticated` read where `workspace_id` ∈ caller's `workspace_members`.
- `research_urls_service` — `service_role` full. All writes go through `createAdminClient()` via [[../libraries/research-urls]].

## Gotchas

- **All writes go through [[../libraries/research-urls]].** A raw `.from('research_urls').insert|update|upsert` anywhere else bypasses URL normalization + the junk-domain skiplist + the unreviewed default. (Chokepoint mirrors the pattern used by [[../libraries/specs-table]] / goals-table.)
- **URL is normalized before it hits the row.** `normalizeUrl` lower-cases the host, strips `?...` and `#...`, and drops a lone trailing slash on paths deeper than `/`. So `HTTPS://Learn.Erthlabs.co/women50/?utm_source=fb#hook` and `https://learn.erthlabs.co/women50` collapse to ONE row.
- **`landing_page_url` beats `destination_domain`.** The sync prefers the full advertorial URL (e.g. `…/women50`) over the bare host (`learn.erthlabs.co`) — mirrors the choice in [[../libraries/landing-page-scout]] `adDestinationsForBrand` because bare-host roots often 404.
- **`JUNK_DOMAINS` filters `linkedin.com` + other non-commerce hosts at sync time.** Rhea's Phase 2 classifier owns `spam` for surviving pages; the skiplist just keeps obvious social-network / short-link destinations out entirely.
- **Verdict is 3-state, not boolean.** `unreviewed` is the default for a freshly synced row; `worthy` / `not_worthy` only after Rhea (or an operator) writes a rationale.

## Written by

[[../libraries/research-urls]] (`syncResearchUrlsFromCreatives` — the ONLY write path; the SDK's `setUrlClassification` / `setTeardownVerdict` land Phase 2's classifier writes) ← [[../inngest/creative-finder]] (`creative-finder-daily-cron`, `creative-finder-manual-sweep`).

## Read by

[[../libraries/research-urls]] (`listResearchUrls`) — Phase 2 Rhea capture+classify loop + owner-facing Growth queue.

## Related

[[../specs/rhea-url-sensor]] · [[../goals/acquisition-research-engine]] · [[creative_skeletons]] · [[../inngest/creative-finder]] · [[../libraries/landing-page-scout]] · [[../functions/growth]]
