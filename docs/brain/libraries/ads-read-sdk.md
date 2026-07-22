# ads-read-sdk

`src/lib/ads/ads-read-sdk.ts` — the **READ chokepoint** for ad campaigns, angles, provenance, crowned winners, and "how was this ad actually made" traces. Read-only; never mutates.

## Why it exists

Hand-rolled `.from("ad_campaigns")` / `.from("product_ad_angles")` probes kept producing **wrong** conclusions during a live Dahlia debugging session:
- an `ilike` on a `uuid` column silently returns **zero rows** (false "not found"),
- a raw select of a non-existent column reads as **empty** (a workspace with angles read as 0).

Per the repo rule **"Raw `.from(...)` with no SDK → STOP"** ([[../../operational-rules.md]]), every read-side answer about an ad, its angle, its explore/exploit provenance, or its execution path now goes through here — typed, column-correct, composed from the SAME canonical helpers the dashboard's `/api/ads/campaigns/[id]` route uses (`readLatestCopyQaVerdict`, `readPostabilityOverride`, `readCopyVariants`, `isPostable`).

Writes are unchanged: they still go through `insertReadyCreative` ([[creative-agent.md]]) and the media-buyer SDK.

## The two derivations (the whole point)

Both were the source of the wrong hand-probe reads.

1. **badge vs true intent** — the stored `provenance.mode` is `isCompetitor ? "explore" : "exploit"` (a **SOURCE** label from `buildAngleProvenance`), NOT the crown-gated slot intent. So an **own-brand** angle is badged `"exploit"` on the detail page **even with zero crowned winners**. `deriveExploreExploit(angle, crownedConcepts)` returns BOTH the stored `badgeMode` AND the true crown-gated `trueIntent`, plus a **`mislabeledExploit`** flag (`badge==='exploit' && no crown`). This is the exact defect behind the "why is everything EXPLOIT?" report.
2. **execution path** — `deriveExecutionPath(authorSelfScore)`: a non-null `author_self_score` (a JSONB `AuthorSelfScore` object) ⇒ the **Dahlia/Max author box session** wrote the copy; NULL ⇒ the **deterministic node path** (`buildMetaCopyPack` — no session, no LF8/Schwartz treatments, no Max gate). `traceAdOrigin` narrates it.

## Surface

| Function | Returns |
|---|---|
| `getAd(admin, {workspaceId, campaignId})` | `AdFull \| null` — campaign + product title + angle (provenance, copy_pack, frameworks) + Max copy-QC verdict + postability override + `maxGraded` + `postable` + `executionPath` + `exploreExploit` |
| `listAds(admin, {workspaceId, productId?, status?, since?, limit?})` | `AdSummary[]` |
| `getAngle(admin, {workspaceId, angleId})` | `AngleRow \| null` (`source` read from `metadata.provenance.source`) |
| `listProductAngles(admin, {workspaceId, productId, source?, activeOnly?})` | `AngleRow[]` |
| `getCrownedWinners(admin, {workspaceId, productId?})` | `CrownedWinner[]` — won/reactivated rows from [[../tables/creative_test_outcomes.md]]; the ONLY thing that legitimately makes an exploit slot |
| `getProductAngleInventory(admin, {workspaceId, productId})` | competitor vs own-brand angle counts, skeletons-by-advertiser, crowns, `expectedExploitSlots` (0 when no crowns) |
| `traceAdOrigin(admin, {workspaceId, campaignId})` | `AdOriginTrace` — the "how was this made" diagnostic: execution path, whether Max graded, whether persuasion treatments ran, badge-vs-truth, + a plain-English `summary`, + best-effort producing `agent_job` link |

Pure, exported, unit-tested (no DB): `deriveExploreExploit`, `deriveExecutionPath`.

## Column truth it encodes

- `ad_campaigns`: `author_self_score` is a **JSONB `AuthorSelfScore`** (`{lf8,schwartz,cialdini,hopkins,sugarman,total,evidence[]}`), not a number; `angle_id`, `concept_tag`, `audience_temperature`, `max_qc_eligible`, `override_*`.
- `product_ad_angles`: there is **no scalar `source` column** — `source`/`mode` live in `metadata.provenance`; the 5-framework pack lives in `metadata.copy_pack.frameworks`.
- `creative_test_outcomes`: `angle_key` + `treatment` + `outcome` (`won`/`lost`/`reactivated`/`pending`); crown = `won`|`reactivated`.

## Related

[[creative-agent.md]] · [[creative-learning.md]] (`angleKey` concept normalizer) · [[creative-qa.md]] (`readLatestCopyQaVerdict`) · [[../tables/creative_test_outcomes.md]] · [[../tables/creative_skeletons.md]] · [[media-buyer-agent.md]] (`isPostable`)
