# `src/lib/media-buyer/director-digest.ts`

media-buyer-director-slack-digest **Phase 2** — the delivery module that posts the media-buyer cohort recommendations as ONE Growth-Director (Max) digest into the founder's private **#director-growth-max** channel ([[../tables/workspaces]] `slack_growth_director_channel_id` = `C0BFW5YUVC1` for Superfoods).

## Why it's a separate module (spec constraint)

The media-buyer agent ([[media-buyer-agent]]) **never posts to Slack directly** — it only writes `<verb>_shadow` [[../tables/director_activity]] rows. THIS module is the sole delivery path: the box worker's media-buyer lane calls it **after** `runMediaBuyerLoop` returns, so the recommendations are rolled up and voiced by the **Director**, not the tool (the north-star tool/supervisor split — the tool proposes rows, the director communicates). It posts AS Max via `postAsGrowthDirector` (mirrors how Ada posts into #cto-ada via `postAsAda`; both use `chat:write.customize` identity from [[../../src/lib/agents/personas]]).

## Exports

- `deliverMediaBuyerDigest(admin, workspaceId, accountPlans)` → `{ posted, reason?, ts? }`. Reads the channel; **skips** (no post) when: **the workspace has `media_buyer_digest_enabled=false`** (the per-workspace off switch — mb-digest-workspace-toggle; the founder silenced the ~2-hourly Bianca digest for Superfoods without touching the media-buyer pass / meta_insights sync / any other Max post — see [[../tables/workspaces]]), no channel is configured, no account has an active policy (a dormant / sensor-trust-denied pass), **the composed digest has zero actionable recommendations** (`hasRecommendations=false` — Phase 1 no-op suppression, so the founder isn't spammed with "no changes recommended this cycle" every 2h), or Slack isn't connected. Otherwise composes a plain-text director-voice digest (`N to scale · M to pause · K replenish · F refresh` + per-cohort summaries) and posts **exactly one** message, then records a `media_buyer_digest_posted` director_activity row (audit anchor + one-per-pass by construction — the worker calls it once).
- `composeDigest(accountPlans)` → `{ text, hasRecommendations }`. Pure formatter — exported so the Phase 1 gates (no-op suppression + product-title label) are unit-tested in isolation (`src/lib/media-buyer/director-digest.test.ts`).

## `AccountPlan` shape

```ts
interface AccountPlan {
  account: string;              // meta_ad_account_id
  productId?: string | null;    // the cohort's product_id (null for legacy Superfood Tabs)
  productTitle?: string | null; // products.title — labels the line ("• Amazing Coffee — …")
  plan: MediaBuyerPlan;         // the per-pass typed plan from computeMediaBuyerPlan
}
```

## Line labeling (Phase 1)

Each surviving line reads `• {ProductTitle} — {summary}` — the founder-legible identifier. A **product-null cohort** (legacy Superfood Tabs today) falls back to `• account {id8} — {summary}`. The caller ([[builder-worker]] media-buyer lane) resolves each pass's `productId` → `products.title` via a batched `.in("id", productIds)` fetch on [[../tables/products]] before calling `deliverMediaBuyerDigest`, so the digest module stays a pure composer.

## Caller

[[builder-worker]] media-buyer lane (`runMediaBuyerLoopForAccount` → per-pass `perAccount` rollup → `deliverMediaBuyerDigest`). Non-fatal: a Slack hiccup logs but never fails the pass. See [[../functions/growth]] · [[../tables/director_activity]] · [[media-buyer-agent]] · `src/lib/slack.ts` (`postAsGrowthDirector`).

## One digest per workspace per pass (Phase 2)

The `deliverMediaBuyerDigest` call posts once per media-buyer job. Under media-buyer-digest-consolidate-product-names-suppress-noop **Phase 2**, the [[../inngest/media-buyer-cadence]] dispatcher now enqueues **exactly one workspace-scoped `kind='media-buyer'` `agent_jobs` row per pass** (rather than one row per active cohort), so a single lane run rolls up every account × per-product cohort and posts **one** consolidated digest — no per-cohort duplicates in `#director-growth-max`. The dormant-heartbeat guarantee (an account with no active cohort still runs one pass with `productId=null` so the audit row lands) lives inside the lane's `runMediaBuyerLoopForAccount` fan-out and is unchanged.
