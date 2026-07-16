# `src/lib/ads/creative-pack-gate.ts` — Publish-boundary refusal for incomplete packs

Bianca's publish-boundary refusal rail ([[../specs/bianca-publishes-3-placement-multi-copy-via-placement-customization]] Phase 3). Where Phase 2's [[ads__placement-publish]] `resolvePlacementPublish` ROUTES a complete pack through the 3-bucket builder and lets an incomplete one fall through to the legacy 2-bucket / single-image path, Phase 3 REFUSES that fall-through for a static campaign Dahlia authored: shipping a 1-image / <4-copy ad from an authored-but-incomplete pack loses the placement + fatigue benefit and produces an inconsistent in-market ad.

Pure predicate (no DB / no fetch / no Meta) — the caller in [[../inngest/ad-tool]] loads the campaign's `ad_videos` + angle metadata and asks the gate. The refuse verdict names ONE of [[creative-pack]]'s stable `CreativePackIncompleteReason` values so downstream escalations / director_activity rows can branch on it. Same north-star principle as the media-buyer publish gate: hit a rail (the pack contract) = ESCALATE, don't degrade. See [[../operational-rules.md]] § North star.

## Exports

| Export | Notes |
|---|---|
| `evaluateCreativePackGate(input)` | Pure. The publisher's pre-flight decision: <br>• `mediaKind !== 'static'` → allow with `skipped:'not_static'` (video ads don't ride the Dahlia placement pack contract; the video publish path is untouched). <br>• No `feed_4x5` canonical row on the campaign → allow with `skipped:'no_dahlia_pack'` (legacy studio-authored campaigns bypass the gate; the single-image / dual-asset paths keep running as before). <br>• Otherwise → run `isCreativePackComplete(snapshot)`. `ready:true` allows; `ready:false` REFUSES with `reason:'missing_creative_pack'` + the pack's specific `packReason` (one of seven `CreativePackIncompleteReason` values) so the escalation can surface what to fix rather than a bare "publish refused". Refuse ORDER matches the pack contract's own short-circuit — the first missing piece is named. |
| `MISSING_CREATIVE_PACK_REASON` | Constant sentinel (`"missing_creative_pack"`) the caller writes to `ad_publish_jobs.publish_status` + escalates on. |
| `CreativePackGateSkipReason` | Skip cases (the pack contract doesn't apply): `not_static` (video / mixed-kind creatives) \| `no_dahlia_pack` (no `feed_4x5` canonical row — legacy studio-authored ad). |
| `CreativePackGateVerdict` | Union: `{ allowed: true; skipped?: CreativePackGateSkipReason }` (allow + optional skip reason) \| `{ allowed: false; reason: 'missing_creative_pack'; packReason: CreativePackIncompleteReason; detail: string }` (refuse + machine-readable reason + human-readable detail). |
| `CreativePackGateInput` | What the gate inspects for one publish job: `{ mediaKind, snapshot: CreativePackSnapshot }`. |
| `missingCreativePackDiagnosis(args)` | Diagnosis string surfaced on the CEO escalation body and the growth `director_activity` row. Names WHAT is missing and WHY that's fatal (a 1-image ad loses the whole point of the placement + fatigue benefit), so a human can fix it (re-render Dahlia's pack / re-run copy) rather than shrug at a boolean. Args: `{ packReason, detail, campaignId }`. |

## Caller

[[../inngest/ad-tool]] `adToolPublishToMeta` — pre-flight gate before publish. Refuses a static campaign whose pack is incomplete (missing a placement static or <4 copy) and escalates via `escalateDiagnosisToCeo` with `escalationKind='bianca_missing_creative_pack'` (deduped by workspace + campaign + packReason) + a growth `director_activity` row (`action_kind='bianca_missing_creative_pack'`).

## Related

[[ads__placement-publish]] (Phase 2 router) · [[creative-pack]] (pack completeness predicate) · [[../lifecycles/ad-publish]]
