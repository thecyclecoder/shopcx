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
| `classification` | `text` | ✓ | CHECK ∈ `advertorial` \| `quiz` \| `generic_pdp` \| `homepage` \| `spam` \| `unviewable` \| `excluded` \| `checkout`. Vocab reuses the [[../libraries/landing-page-scout]] `page_type` labels plus the two failure cases plus the two Phase-2 deterministic-gate values (`excluded` — non-lander domain / login wall; `checkout` — checkout/cart page, out of scope for the lander teardown pipeline). Null until Rhea's classifier or the sync's deterministic gate stamps it. See [[../specs/rhea-research-automation]] Phase 2. |
| `teardown_verdict` | `text` | — | default `'unreviewed'` · CHECK ∈ `worthy` \| `not_worthy` \| `unreviewed`. Rhea flips based on her rationale; the sync's deterministic gate pre-stamps `not_worthy` for `excluded` rows. |
| `rationale` | `text` | ✓ | One-sentence citation of what was seen (Rhea) or WHY the row was gated (`'non-lander domain (social/login/app-store/aggregator)'` for `excluded`, `'checkout page — out of scope (separate feature)'` for `checkout`). Null on `unreviewed`. |
| `capture_ref` | `text` | ✓ | Pointer into the private `research-shots` Storage bucket — the path prefix under which the chapter shots for the last capture live. Written by [[../libraries/research-urls]] `setCaptureRef` after a successful Playwright capture ([[../recipes/lander-capture]]). Null until Phase 2 captures. |
| `teardown` | `jsonb` | ✓ | Rhea's structured teardown recipe for a worthy lander (`TeardownRecipe` — funnel_type + strategy + architecture[] + reason_sequence[]? + levers[] + offer + transferable_pattern). Written by [[../libraries/research-urls]] `setTeardown` in the same `runResearchJob` session as the classify pass (no re-render — reuses the captured chapters). Null on `not_worthy` / `unviewable` / pre-teardown rows. The artifact [[../functions/growth]]'s Cleo (slice 3) reads to diff against our storefront and emit a build blueprint. See [[../specs/rhea-teardown-recipe]]. |
| `classified_at` | `timestamptz` | ✓ | When `classification` was set. |
| `classified_by` | `text` | ✓ | `'rhea'` for the box classifier; `'deterministic'` for the Phase-2 sync gate (`excluded` / `checkout`); operator email on manual override. Free-text on purpose. |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()`, auto-bumped by `research_urls_touch_updated_at` on any UPDATE. |

**Unique:** `(workspace_id, url)` — the idempotent upsert key; re-running the sync updates `ad_count` / `last_seen` in place.

**Indexes:** `(workspace_id, domain)`, `(workspace_id, teardown_verdict)` — browse-by-domain + Rhea's queue-by-verdict.

## Recipe shape (`teardown` jsonb)

`teardown` stores a `TeardownRecipe` (see [[../libraries/research-urls]] for the full `TeardownRecipe` / `TeardownLever` type + [[../recipes/lander-teardown]] for the fully-worked erthlabs 8-reasons example). Field-by-field:

- **`funnel_type`** (string) — broad classification: `"advertorial-listicle"`, `"quiz"`, `"generic_pdp"`, …
- **`strategy`** (string) — one-sentence summary of the funnel play.
- **`architecture`** — ORDERED list of `{ chapter_role, purpose }` from hero → intro/proof → … → offer → faq → testimonials. The skeleton Cleo diffs against.
- **`reason_sequence`** — OPTIONAL. Present for listicle-style landers: `{ order, benefit, appeal ∈ emotion|logic, mechanism }` per numbered reason.
- **`levers`** — Non-empty list of `{ lever, evidence }`. `lever` is one of `authority | social_proof | ugc | urgency | price_anchor | risk_reversal | value_stack | objection_handling | specificity | bandwagon | choice_simplicity`. `evidence` is the CONCRETE beat Rhea saw (e.g. `"'50,000+ happy customers' + testimonials chapter at the end"`).
- **`offer`** — `{ discount?, bundle?, bonuses?[], guarantee?, urgency?, options }`. `options` is the count of purchase paths (1 = single option, the erthlabs default).
- **`transferable_pattern`** — Non-empty product-agnostic string. The skeleton we could port to a Superfoods lander.

The write path (`setTeardown` in [[../libraries/research-urls]]) runs `validateTeardownRecipe` and REJECTS a half-formed recipe — empty `architecture`, empty `levers`, missing `transferable_pattern`, unknown lever tag, or non-positive `offer.options` all throw before the row is touched.

## RLS

- `research_urls_select` — `authenticated` read where `workspace_id` ∈ caller's `workspace_members`.
- `research_urls_service` — `service_role` full. All writes go through `createAdminClient()` via [[../libraries/research-urls]].

## Gotchas

- **All writes go through [[../libraries/research-urls]].** A raw `.from('research_urls').insert|update|upsert` anywhere else bypasses URL normalization + the deterministic non-lander/checkout gate + the unreviewed default. (Chokepoint mirrors the pattern used by [[../libraries/specs-table]] / goals-table.)
- **Deterministic gate (Phase 2) KEEPS gated rows, doesn't drop them.** A non-lander domain (social/login/app-store/aggregator/search) or checkout URL is upserted like any other row but pre-stamped `classification='excluded'|'checkout'` + `classified_by='deterministic'`, so the [[../inngest/research-sensor]] claim (`classification IS NULL`) can never see them — while the row is still auditable. The old JUNK_DOMAINS drop-at-sync behavior is gone.
- **URL is normalized before it hits the row.** `normalizeUrl` lower-cases the host, strips `?...` and `#...`, and drops a lone trailing slash on paths deeper than `/`. So `HTTPS://Learn.Erthlabs.co/women50/?utm_source=fb#hook` and `https://learn.erthlabs.co/women50` collapse to ONE row.
- **`landing_page_url` beats `destination_domain`.** The sync prefers the full advertorial URL (e.g. `…/women50`) over the bare host (`learn.erthlabs.co`) — mirrors the choice in [[../libraries/landing-page-scout]] `adDestinationsForBrand` because bare-host roots often 404.
- **`spam` is Rhea's call, not the sync's.** The deterministic gate only fires on OBVIOUS non-lander domains + checkout URLs (`excluded` / `checkout`); a URL that looks commercial-but-empty is `spam`, and only Rhea's Phase-2 classifier writes that.
- **Verdict is 3-state, not boolean.** `unreviewed` is the default for a freshly synced row; `worthy` / `not_worthy` only after Rhea (or an operator) writes a rationale.

## Written by

[[../libraries/research-urls]] (`syncResearchUrlsFromCreatives` — the ONLY write path for INSERTs; the SDK's `setUrlClassification` / `setTeardownVerdict` / `setCaptureRef` / `setTeardown` land Phase 2's classifier writes) ← [[../inngest/creative-finder]] (`creative-finder-daily-cron`, `creative-finder-manual-sweep`) + [[builder-worker]] `runResearchJob` (Phase 2 — captures via [[../recipes/lander-capture]] then applies Rhea's decisions via the SDK, including the same-session structured teardown for worthy URLs — [[../recipes/lander-teardown]]).

## Read by

[[../libraries/research-urls]] (`listResearchUrls`) — Phase 2 Rhea capture+classify loop + owner-facing Growth queue.

## Related

[[../specs/rhea-url-sensor]] · [[../specs/rhea-teardown-recipe]] · [[../goals/acquisition-research-engine]] · [[creative_skeletons]] · [[../inngest/creative-finder]] · [[../inngest/acquisition-research-cadence]] · [[../recipes/lander-capture]] · [[../recipes/lander-teardown]] · [[../libraries/landing-page-scout]] · [[../functions/growth]]
