# `src/lib/ads/postability-override.ts`

**CEO manual postability override SDK** — the read/set/clear chokepoint for the
five `ad_campaigns` override columns (`override_postable / override_score /
override_reason / override_by / override_at`) added by
[[../specs/bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate]]
Phase 2. Every override read/write flows through the helpers here so the shape
of the record cannot drift between the [[media-buyer-publish-gate]] money-step
rail, the [[ready-to-test]] Bianca reader, and the ad-detail API route.

**North-star invariant.** Max's real grade lives on
[[../tables/ad_creative_copy_qc_verdicts]] and is NEVER touched by this SDK —
the whole point of the CEO override is that the disagreement (Max says 6/10;
CEO says post) is preserved next to Max's real number as the tuning signal for
future live Claude sessions where the CEO tunes HOW Max grades. The override
lives on [[../tables/ad_campaigns]] alongside `max_qc_eligible` (the
Max-computed postability flag from the prior spec) — orthogonal columns, one
authored by the always-bin path and one authored by the CEO.

## Exports

- **`PostabilityOverride`** — the persisted record shape (`override_postable /
  override_score / override_reason / override_by / override_at`, all nullable).
  Every field travels together: either "override present" (`override_postable
  === true`) or "no override" (all fields null). Reversible = clear all five.
- **`isPostabilityOverrideActive(o)`** — pure predicate. `TRUE` iff
  `o?.override_postable === true`. NULL / `FALSE` / absent record → `false`.
  There is no `FALSE` state on the record — clearing an override nulls all five
  columns together (per the migration comment).
- **`normalizeOverrideReason(raw)`** — trims + rejects empty / whitespace-only
  strings; caps at 1000 chars. The API layer surfaces `missing_reason` on
  `null` output. Pure — pinned by the four `normalizeOverrideReason` cases in
  [[../../../src/lib/ads/postability-override.test.ts]].
- **`normalizeOverrideScore(raw)`** — clamps to the DB CHECK range `[0, 10]`;
  truncates non-integers; returns `null` for `null` / `undefined` / `NaN`.
  Called by `setPostabilityOverride` with `MAX_QC_ELIGIBILITY_FLOOR` as the
  default when the CEO didn't supply a score.
- **`readPostabilityOverride(admin, {workspaceId, adCampaignId})`** — read
  chokepoint. Returns the record even when no override has been set (all
  fields null) so the caller can distinguish "row exists, override absent"
  from "row missing" (the latter is `null`). Read by [[media-buyer-publish-gate]]
  `evaluateMaxCopyQcAtPublish` (in parallel with `readLatestCopyQaVerdict`) and
  by [[../../../src/app/api/ads/campaigns/[id]/route.ts]] for the ad detail page.
- **`setPostabilityOverride(admin, {workspaceId, adCampaignId, reason, userId,
  score?, scoreFloor})`** — set/update the override. Compare-and-set write
  (`.eq("id", adCampaignId).eq("workspace_id", workspaceId).select("id, …")
  .maybeSingle()`) so a mismatched workspace/campaign returns `matched:false`
  instead of silently touching a wrong row (CLAUDE.md coaching #11-12). Reason
  is `normalizeOverrideReason`d; score is `normalizeOverrideScore`d and falls
  back to `scoreFloor` (usually `MAX_QC_ELIGIBILITY_FLOOR = 9`). NEVER reads or
  writes `ad_creative_copy_qc_verdicts` — Max's real grade is out of scope by
  design.
- **`clearPostabilityOverride(admin, {workspaceId, adCampaignId})`** — nulls
  all five columns. Reversible per the spec — the CEO can re-set later.

## Semantics

`override_postable = TRUE`  → Bianca posts REGARDLESS of `max_qc_eligible`
                              (CEO said so; Max's real grade preserved on the
                              QC verdict row).
`override_postable = NULL`  → no override in play; fall back to
                              `max_qc_eligible` (pre-Phase-2 behavior
                              byte-for-byte: TRUE / NULL post, FALSE holds).

There is **no `override_postable = FALSE`** — a CEO who wants to un-post
clears the whole override. Enforced by the write helpers (both `set` and
`clear` never write `false` into `override_postable`).

## Callers

- [[media-buyer-publish-gate]] `evaluateMaxCopyQcAtPublish` — the money-step
  gate. Reads Max's verdict + this override in parallel; an active override
  shortcuts to `ok:true` with Max's real verdict preserved on the allow-result
  (`{ ok: true, verdict, scoreFloor, override }`).
- [[ready-to-test]] `listReadyToTest` — the Bianca reader. Widens its DB
  filter to `max_qc_eligible IS NULL OR max_qc_eligible=TRUE OR
  override_postable IS TRUE` so a CEO-overridden creative surfaces even when
  `max_qc_eligible=false`. JS-side belt-and-suspenders mirror below.
- [[../../../src/app/api/ads/campaigns/[id]/postability-override/route.ts]] —
  the owner/admin-only POST (set) + DELETE (clear) actions the ad detail
  page's `PostabilityOverrideCard` invokes. Each successful write records a
  `ceo_postability_override_set` / `ceo_postability_override_cleared`
  [[director_activity]] row (best-effort — the override itself is the durable
  action).
- [[../../../src/app/api/ads/campaigns/[id]/route.ts]] — the ad detail GET.
  Returns `postabilityOverride` alongside `copyQaVerdict` so the UI renders
  both Max's real grade AND the override without a second fetch.

## Related

[[../tables/ad_campaigns]] · [[../tables/ad_creative_copy_qc_verdicts]] · [[media-buyer-publish-gate]] · [[ready-to-test]] · [[creative-agent]] (`MAX_QC_ELIGIBILITY_FLOOR`) · [[director-activity]] · [[../specs/bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
