# `src/lib/research-urls.ts` — Rhea's URL sensor SDK

The chokepoint for [[../tables/research_urls]]: the ONLY file allowed to write the table. Owns URL normalization, the junk-domain skiplist, and the deterministic sync from [[creative-skeleton]] / [[../inngest/creative-finder]]. Phase 1 of [[../specs/rhea-url-sensor]] (M1 of [[../goals/acquisition-research-engine]]) — extended in [[../specs/rhea-teardown-recipe]] with the `TeardownRecipe` type + `setTeardown` write for the structured teardown Cleo consumes (slice 3 input).

**North-star (supervisable autonomy):** the sync proposes rows (`teardown_verdict='unreviewed'`); Phase 2's Rhea classifies via `setUrlClassification` / `setTeardownVerdict` and — for a worthy verdict — reverse-engineers the funnel into a `TeardownRecipe` persisted via `setTeardown` (SAME session as the classify pass, no re-render — see [[../recipes/lander-teardown]]); an owner (Growth) reviews. This file NEVER acts.

## Exports

| Export | Notes |
|---|---|
| `syncResearchUrlsFromCreatives(workspaceId)` | Walk [[../tables/creative_skeletons]] for the workspace, dedup by normalized URL (prefer `landing_page_url` over `destination_domain`), count ads per destination into `ad_count`, drop URLs on `JUNK_DOMAINS`, and upsert one row per distinct destination as `teardown_verdict='unreviewed'`. Idempotent (UNIQUE `(workspace_id, url)` + upsert). Returns `SyncResearchUrlsResult` counts. Called by [[../inngest/creative-finder]] after each per-workspace sweep. |
| `listResearchUrls(workspaceId, filter?)` | Read helper — filter by `domain` \| `brand` \| `classification` \| `teardown_verdict` \| `competitor_id`; ordered by `ad_count desc`, default limit 500. Returns the row's `teardown` recipe (if any) round-tripped on the `ResearchUrl.teardown` field. |
| `setUrlClassification(workspaceId, id, classification, classifiedBy='rhea')` | Rhea's classify write (Phase 2). Stamps `classification` + `classified_at` + `classified_by`. Vocab is the CHECK constraint: `advertorial` \| `quiz` \| `generic_pdp` \| `homepage` \| `spam` \| `unviewable`. |
| `setTeardownVerdict(workspaceId, id, verdict, rationale)` | Rhea's verdict write. `verdict ∈ worthy \| not_worthy \| unreviewed`; `rationale` is the one-sentence citation of what she saw. |
| `setCaptureRef(workspaceId, id, captureRef)` | Rhea's capture-pointer write (Phase 2). Stamps the storage-path prefix under the private `research-shots` bucket where the chapter shots live — the box lane calls this after a successful capture so the manifest can be re-opened later. |
| `setTeardown(workspaceId, id, recipe)` | Rhea's structured teardown write ([[../specs/rhea-teardown-recipe]] Phase 1 SDK + Phase 2 driver — worthy only, same session, no re-render). Runs `validateTeardownRecipe` (throws on empty `architecture` / `levers` / `transferable_pattern`, unknown lever tag, missing `funnel_type` / `strategy`, malformed `reason_sequence` entries, non-positive `offer.options`) BEFORE the write — a half-formed recipe never reaches the row (author-spec gate discipline). Persists to `research_urls.teardown` via `createAdminClient()`. Cleo's input for slice 3 (gap analysis → build blueprint). |
| `validateTeardownRecipe(recipe)` | Author-spec-style gate — the same validator `setTeardown` runs internally, exported so one-off scripts / tests can assert a recipe before storing it. Throws on failure; returns void on pass. |
| `normalizeUrl(raw)` | `HTTPS://Learn.Erthlabs.co/women50/?utm_source=fb#hook` → `https://learn.erthlabs.co/women50`. Lower-cases the host; strips query + hash; drops a lone trailing slash on paths deeper than `/`. Returns `null` on parse failure. Exported for tests + one-off scripts. |
| `isJunkUrl(normalizedUrl)` | True for `linkedin.com` / social / short-link hosts on the built-in `JUNK_DOMAINS` skiplist. |
| `ResearchUrl` / `ResearchUrlFilter` / `ResearchUrlClassification` / `ResearchUrlVerdict` / `TeardownRecipe` / `TeardownLever` / `SyncResearchUrlsResult` | Types |

## `TeardownRecipe` shape

The artifact Rhea emits per worthy URL (same session as the classify pass — [[../recipes/lander-teardown]] has the erthlabs 8-reasons worked example). Persisted to `research_urls.teardown` (jsonb) by `setTeardown`; Cleo reads it to diff against our storefront and emit a build blueprint (slice 3).

```ts
type TeardownLever =
  | "authority" | "social_proof" | "ugc" | "urgency" | "price_anchor"
  | "risk_reversal" | "value_stack" | "objection_handling"
  | "specificity" | "bandwagon" | "choice_simplicity";

interface TeardownRecipe {
  funnel_type: string;                                       // "advertorial-listicle" | "quiz" | "generic_pdp" | …
  strategy: string;                                          // one-sentence funnel play summary
  architecture: { chapter_role: string; purpose: string }[]; // ordered — hero → intro → … → offer → faq
  reason_sequence?: {                                        // OPTIONAL — populate for listicle-style landers
    order: number;
    benefit: string;
    appeal: "emotion" | "logic";
    mechanism: string;
  }[];
  levers: { lever: TeardownLever; evidence: string }[];      // each carries the concrete evidence Rhea saw
  offer: {
    discount?: string;
    bundle?: string;
    bonuses?: string[];
    guarantee?: string;
    urgency?: string;
    options: number;                                          // count of purchase paths — 1 = single option
  };
  transferable_pattern: string;                              // product-agnostic skeleton — how we'd port to Superfoods
}
```

Extending `TeardownLever` requires a spec change — the point of the union is a **stable vocabulary** Cleo can gap-analyze against our storefront.

## The sync (`syncResearchUrlsFromCreatives`)

1. Read every `creative_skeletons` row for `workspace_id` (ordered oldest-first).
2. Per row, pick a candidate URL: `landing_page_url` if present, else `https://` + `destination_domain`. `landing_page_url` wins because the bare-host root often 404s — mirrors [[landing-page-scout]] `adDestinationsForBrand`.
3. Normalize (`normalizeUrl`). Drop parse failures.
4. Skip URLs on `JUNK_DOMAINS` (linkedin.com, facebook.com, instagram.com, x.com, tiktok.com, youtube.com, pinterest.com, google.com, apple.com, wa.me, bit.ly + subdomains).
5. Aggregate by normalized URL: bump `ad_count`, min-collapse `first_seen`, max-collapse `last_seen`, first non-null `seed_keyword` wins as `brand`.
6. Upsert on `(workspace_id, url)` with `teardown_verdict='unreviewed'`.

Idempotent — a second run against the same `creative_skeletons` set writes identical rows.

## Gotchas

- **Chokepoint discipline.** All writes go through this file via `createAdminClient()`. A raw `.from('research_urls').insert|update|upsert` anywhere else skips normalization + the junk skiplist + the unreviewed default. Mirrors the pattern used by [[specs-table]] / [[goals-table]].
- **URL normalization matters.** `HTTPS://Learn.Erthlabs.co/women50/?utm_source=fb#hook` and `https://learn.erthlabs.co/women50` MUST collapse to one row — the UNIQUE key is on the normalized string.
- **`landing_page_url` beats `destination_domain`.** ~half of AdLibrary rows carry the full advertorial URL (WITH path); the bare host root frequently 404s. Prefer the full URL when present.
- **`brand` is best-effort.** The first non-null `seed_keyword` we see for a URL wins. Cross-brand ambiguity (two competitors' ads pointing at the same aggregator) resolves to whichever brand landed first.
- **`ad_count` refreshes on every sync.** Because the sync recomputes counts from the ground up per run, a rerun after a burst of new creatives lifts `ad_count` to match — no drift.

## Callers

- [[../inngest/creative-finder]] (`creative-finder-daily-cron`, `creative-finder-manual-sweep`) — `syncResearchUrlsFromCreatives` per workspace after `sweepSeed` + `promoteWhitelistedPages`.
- [[../inngest/acquisition-research-cadence]] — dedup-gated enqueue of the `research` box job per workspace per beat (Phase 2 driver).
- [[builder-worker]] (`runResearchJob`, Phase 2) — captures via [[../recipes/lander-capture]] then calls `setUrlClassification` / `setTeardownVerdict` / `setCaptureRef` per URL in Rhea's batch, and (for worthy URLs) persists the same-session `TeardownRecipe` via `setTeardown` ([[../recipes/lander-teardown]]).
- Owner-facing Growth queue (later) — `listResearchUrls`.

## Related

[[../tables/research_urls]] · [[../specs/rhea-url-sensor]] · [[../specs/rhea-teardown-recipe]] · [[../goals/acquisition-research-engine]] · [[../tables/creative_skeletons]] · [[creative-skeleton]] · [[../inngest/creative-finder]] · [[../inngest/acquisition-research-cadence]] · [[../recipes/lander-capture]] · [[../recipes/lander-teardown]] · [[landing-page-scout]] · [[../functions/growth]]
