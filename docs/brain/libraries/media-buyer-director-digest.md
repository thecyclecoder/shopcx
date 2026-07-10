# `src/lib/media-buyer/director-digest.ts`

media-buyer-director-slack-digest **Phase 2** — the delivery module that posts the media-buyer cohort recommendations as ONE Growth-Director (Max) digest into the founder's private **#director-growth-max** channel ([[../tables/workspaces]] `slack_growth_director_channel_id` = `C0BFW5YUVC1` for Superfoods).

## Why it's a separate module (spec constraint)

The media-buyer agent ([[media-buyer-agent]]) **never posts to Slack directly** — it only writes `<verb>_shadow` [[../tables/director_activity]] rows. THIS module is the sole delivery path: the box worker's media-buyer lane calls it **after** `runMediaBuyerLoop` returns, so the recommendations are rolled up and voiced by the **Director**, not the tool (the north-star tool/supervisor split — the tool proposes rows, the director communicates). It posts AS Max via `postAsGrowthDirector` (mirrors how Ada posts into #cto-ada via `postAsAda`; both use `chat:write.customize` identity from [[../../src/lib/agents/personas]]).

## Export

- `deliverMediaBuyerDigest(admin, workspaceId, accountPlans)` → `{ posted, reason?, ts? }`. Reads the channel; **skips** (no post) when no channel is configured, Slack isn't connected, or no account has an active policy (a dormant / sensor-trust-denied pass has nothing to report). Otherwise composes a plain-text director-voice digest (`N to scale · M to pause · K replenish · F refresh` + per-account summaries) and posts **exactly one** message, then records a `media_buyer_digest_posted` director_activity row (audit anchor + one-per-pass by construction — the worker calls it once).

## Caller

[[builder-worker]] media-buyer lane (`runMediaBuyerLoop` → `deliverMediaBuyerDigest`). Non-fatal: a Slack hiccup logs but never fails the pass. See [[../functions/growth]] · [[../tables/director_activity]] · [[media-buyer-agent]] · `src/lib/slack.ts` (`postAsGrowthDirector`).
