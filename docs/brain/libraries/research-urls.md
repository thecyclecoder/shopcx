# `src/lib/research-urls.ts` — Rhea's URL sensor SDK

The chokepoint for [[../tables/research_urls]]: the ONLY file allowed to write the table. Owns URL normalization, the junk-domain skiplist, and the deterministic sync from [[creative-skeleton]] / [[../inngest/creative-finder]]. Phase 1 of [[../specs/rhea-url-sensor]] (M1 of [[../goals/acquisition-research-engine]]) — extended in [[../specs/rhea-teardown-recipe]] with the `TeardownRecipe` type + `setTeardown` write for the structured teardown Cleo consumes (slice 3 input).

**North-star (supervisable autonomy):** the sync proposes rows (`teardown_verdict='unreviewed'`); Phase 2's Rhea classifies via `setUrlClassification` / `setTeardownVerdict` and — for a worthy verdict — reverse-engineers the funnel into a `TeardownRecipe` persisted via `setTeardown` (SAME session as the classify pass, no re-render — see [[../recipes/lander-teardown]]); an owner (Growth) reviews. This file NEVER acts.

## Exports

| Export | Notes |
|---|---|
| `syncResearchUrlsFromCreatives(workspaceId)` | Walk [[../tables/creative_skeletons]] for the workspace, dedup by normalized URL (prefer `landing_page_url` over `destination_domain`), count ads per destination into `ad_count`, drop URLs on `JUNK_DOMAINS`, and upsert one row per distinct destination as `teardown_verdict='unreviewed'`. Idempotent (UNIQUE `(workspace_id, url)` + upsert). Returns `SyncResearchUrlsResult` counts. Called by [[../inngest/creative-finder]] after each per-workspace sweep. |
| `listResearchUrls(workspaceId, filter?)` | Read helper — filter by `domain` \| `brand` \| `classification` \| `teardown_verdict` \| `competitor_id`; ordered by `ad_count desc`, default limit 500. Returns the row's `teardown` recipe (if any) round-tripped on the `ResearchUrl.teardown` field. |
| `getResearchUrl(workspaceId, id)` | Single-row read (workspace-scoped). Returns `null` when the row doesn't exist. The `/api/research/landers/[id]` detail surface calls this before pairing the row with signed chapter URLs. |
| `signResearchShot(path, ttlSec?)` | Short-lived signed URL for a chapter shot stored under the private `research-shots` bucket (default TTL `RESEARCH_SHOTS_SIGNED_TTL_SEC` = 1 hour). Mirror of [[landing-page-scout]] `signLanderShot` but for Rhea's capture manifest — the ONLY read path for a stored chapter (the bucket is not public). |
| `listResearchShotChapters(captureRef, ttlSec?)` | List every chapter file under a `capture_ref` prefix and return `{ index, label, path, signed_url }[]`, sorted by the trailing `-chapter-N.png` index (matches the capture-time order). Returns `[]` when `captureRef` is null. The owner-facing `/api/research/landers/[id]` reader uses this to hand the UI the chaptered mobile shots alongside the structured `teardown`. |
| `RESEARCH_SHOTS_BUCKET` | The private bucket name — one string owned here so it can't drift between the writer ([[../recipes/lander-capture]]) and the reader (`signResearchShot`). |
| `setUrlClassification(workspaceId, id, classification, classifiedBy='rhea')` | Rhea's classify write (Phase 2). Stamps `classification` + `classified_at` + `classified_by`. Vocab is the CHECK constraint: `advertorial` \| `quiz` \| `generic_pdp` \| `homepage` \| `spam` \| `unviewable`. |
| `setTeardownVerdict(workspaceId, id, verdict, rationale)` | Rhea's verdict write. `verdict ∈ worthy \| not_worthy \| unreviewed`; `rationale` is the one-sentence citation of what she saw. |
| `setCaptureRef(workspaceId, id, captureRef)` | Rhea's capture-pointer write (Phase 2). Stamps the storage-path prefix under the private `research-shots` bucket where the chapter shots live — the box lane calls this after a successful capture so the manifest can be re-opened later. |
| `setTeardown(workspaceId, id, recipe)` | Rhea's structured teardown write ([[../specs/rhea-teardown-recipe]] Phase 1 SDK + Phase 2 driver — worthy only, same session, no re-render). Runs `validateTeardownRecipe` (throws on empty `architecture` / `levers` / `transferable_pattern`, unknown lever tag, missing `funnel_type` / `strategy`, malformed `reason_sequence` entries, non-positive `offer.options`) BEFORE the write — a half-formed recipe never reaches the row (author-spec gate discipline). Persists to `research_urls.teardown` via `createAdminClient()`. Cleo's input for slice 3 (gap analysis → build blueprint). |
| `validateTeardownRecipe(recipe)` | Author-spec-style gate — the same validator `setTeardown` runs internally, exported so one-off scripts / tests can assert a recipe before storing it. Throws on failure; returns void on pass. |
| `listNewTeardowns(workspaceId, limit=50)` | Cleo's DISCOVERY reader ([[../specs/rhea-research-automation]] Phase 3). Rows where `teardown IS NOT NULL AND growth_reviewed_at IS NULL`, ordered `ad_count DESC` (highest-spend competitor funnels first). Naturally EXCLUDES `excluded` / `checkout` / `not_worthy` / `unviewable` rows because none of them carry a teardown. The input trigger the slice-4 gap-analysis loop will consume. |
| `markTeardownReviewed(workspaceId, id)` | Cleo's watermark stamp — sets `growth_reviewed_at = now()`, dropping the row out of `listNewTeardowns`. Idempotent. The ONLY write path for `growth_reviewed_at`. |
| `normalizeUrl(raw)` | `HTTPS://Learn.Erthlabs.co/women50/?utm_source=fb#hook` → `https://learn.erthlabs.co/women50`. Lower-cases the host; strips query + hash; drops a lone trailing slash on paths deeper than `/`. Returns `null` on parse failure. Exported for tests + one-off scripts. |
| `classifyNonLanderGate(normalizedUrl)` | rhea-research-automation Phase 2 deterministic gate — returns `{classification:'excluded', rationale:'non-lander domain (social/login/app-store/aggregator)'}` for a `NON_LANDER_DOMAINS` host / subdomain / `accounts.` login / `/login`/`/signin` path; `{classification:'checkout', rationale:'checkout page — out of scope (separate feature)'}` for a `/checkout`/`/cart` path or `checkout.`/`pay.` subdomain; else null. Sync uses it to pre-stamp gated rows so the [[../inngest/research-sensor]] claim (`classification IS NULL`) can never see them. |
| `isJunkUrl(normalizedUrl)` | @deprecated shim — true when `classifyNonLanderGate` returns non-null (i.e. the URL would be gated as `excluded` or `checkout`). Kept for callers outside the sync. |
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
4. Aggregate by normalized URL: bump `ad_count`, min-collapse `first_seen`, max-collapse `last_seen`, first non-null `seed_keyword` wins as `brand`. Run `classifyNonLanderGate` on the URL — a non-null verdict is carried into the payload.
5. Upsert on `(workspace_id, url)`. A gated verdict pre-stamps `classification='excluded'|'checkout'` + `teardown_verdict='not_worthy'` + `classified_by='deterministic'` + `rationale` so the row is INVISIBLE to the [[../inngest/research-sensor]] claim (`classification IS NULL`) but still auditable; ungated rows upsert with `teardown_verdict='unreviewed'`.

Idempotent — a second run against the same `creative_skeletons` set writes identical rows.

## Cleo handoff (`listNewTeardowns` + `markTeardownReviewed`)

Phase 3 of [[../specs/rhea-research-automation]] — the DISCOVERY surface between Rhea's per-URL classify-plus-teardown loop and Cleo's slice-4 gap-analysis loop. Cleo polls `listNewTeardowns` for new findings (rows Rhea has landed a `teardown` recipe on but Cleo hasn't marked reviewed), consumes them into her gap analysis, then calls `markTeardownReviewed` to advance the watermark. A partial index `(workspace_id, ad_count desc) WHERE teardown IS NOT NULL AND growth_reviewed_at IS NULL` keeps the read fast even as the table grows.

## Gotchas

- **Chokepoint discipline.** All writes go through this file via `createAdminClient()`. A raw `.from('research_urls').insert|update|upsert` anywhere else skips normalization + the junk skiplist + the unreviewed default. Mirrors the pattern used by [[specs-table]] / [[goals-table]].
- **URL normalization matters.** `HTTPS://Learn.Erthlabs.co/women50/?utm_source=fb#hook` and `https://learn.erthlabs.co/women50` MUST collapse to one row — the UNIQUE key is on the normalized string.
- **`landing_page_url` beats `destination_domain`.** ~half of AdLibrary rows carry the full advertorial URL (WITH path); the bare host root frequently 404s. Prefer the full URL when present.
- **`brand` is best-effort.** The first non-null `seed_keyword` we see for a URL wins. Cross-brand ambiguity (two competitors' ads pointing at the same aggregator) resolves to whichever brand landed first.
- **`ad_count` refreshes on every sync.** Because the sync recomputes counts from the ground up per run, a rerun after a burst of new creatives lifts `ad_count` to match — no drift.

## Callers

- [[../inngest/creative-finder]] (`creative-finder-daily-cron`, `creative-finder-manual-sweep`) — `syncResearchUrlsFromCreatives` per workspace after `sweepSeed` + `promoteWhitelistedPages`.
- [[../inngest/research-sensor]] — the paced HOURLY claim (rhea-research-automation Phase 1). Runs `syncResearchUrlsFromCreatives` then enqueues ONE `research` job carrying the top-`ad_count` unreviewed URL id (dedup-gated).
- [[builder-worker]] (`runResearchJob`) — captures via [[../recipes/lander-capture]] then calls `setUrlClassification` / `setTeardownVerdict` / `setCaptureRef` per URL, and (for worthy URLs) persists the same-session `TeardownRecipe` via `setTeardown` ([[../recipes/lander-teardown]]).
- Cleo (Growth, slice 4 loop — coming) — `listNewTeardowns` / `markTeardownReviewed`. The rhea-research-automation Phase 3 discovery surface.
- Owner-facing Growth queue — `listResearchUrls`.
- `src/app/api/research/landers/route.ts` — owner-gated list surface for `/dashboard/research/landers`; calls `listResearchUrls` and projects to a list-view shape (adds `has_teardown`).
- `src/app/api/research/landers/[id]/route.ts` — owner-gated detail surface; calls `getResearchUrl` for the full row (including the `teardown` recipe) and `listResearchShotChapters` for the signed chapter URLs.
- `src/app/api/research/teardowns/route.ts` — owner-gated **curated gallery** reader for [[../dashboard/research__teardowns]]; calls `listResearchUrls({ has_teardown: true })` and projects to a list-view shape (adds `funnel_type` from the recipe + a `showcase_href`).
- `src/app/showcase/tools/teardowns/examples/[id]/page.tsx` — the founder-approved server-rendered HTML board on the [[../lifecycles/showcase]]; calls `getResearchUrlById` (workspace-agnostic — the Showcase carries no workspace context under the password gate) + `listResearchShotChapters` for the ordered chapters + `signResearchShot` per shot.

## Related

[[../tables/research_urls]] · [[../specs/rhea-url-sensor]] · [[../specs/rhea-teardown-recipe]] · [[../specs/rhea-research-automation]] · [[../goals/acquisition-research-engine]] · [[../tables/creative_skeletons]] · [[creative-skeleton]] · [[../inngest/creative-finder]] · [[../inngest/acquisition-research-cadence]] · [[../inngest/research-sensor]] · [[../recipes/lander-capture]] · [[../recipes/lander-teardown]] · [[landing-page-scout]] · [[../functions/growth]] · [[../dashboard/research__landers]] (owner viewer) · [[../dashboard/research__teardowns]] (curated gallery + Showcase HTML board) · [[../lifecycles/showcase]]
