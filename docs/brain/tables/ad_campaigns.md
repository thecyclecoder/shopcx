# ad_campaigns

A single ad concept: product × variant × [[product_ad_angles|angle]] × [[ad_avatars|avatar]], plus script and render settings. Each campaign fans out into 4 [[ad_videos]] sibling rows.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | ✓ |  |
| `product_id` | `uuid` | — | → [[products]].id |
| `avatar_id` | `uuid` | ✓ | → [[ad_avatars]].id · ON DELETE SET NULL |
| `variant_id` | `uuid` | ✓ | → [[product_variants]].id |
| `angle_id` | `uuid` | ✓ | → [[product_ad_angles]].id |
| `script_text` | `text` | ✓ |  |
| `length_sec` | `int4` | — | default: `15` · `15` \| `30` |
| `voice_id` | `text` | ✓ |  |
| `caption_style` | `text` | — | default: `'hormozi_yellow'` |
| `vibe_tags` | `text[]` | ✓ |  |
| `scene_style` | `text` | — | default: `'outdoor_selfie'` · the shot's setting + action (kitchen counter, walk & talk, couch, car selfie, desk…). Drives the hero image + Veo talking-head prompts. Values in [[../libraries/ad-tool-config]] `AD_SCENE_STYLES` (plain text, not an enum). See [[../lifecycles/ad-render]]. |
| `hero_image_url` | `text` | ✓ | holding-product shot (Nano Banana Pro) |
| `audio_url` | `text` | ✓ | legacy TTS (vestigial in the Veo stack) |
| `composition` | `jsonb` | ✓ | the **stitch recipe**: ordered [[ad_segments]] refs + b-roll overlays + music mix. Render reads it; re-launch refresh swaps one segment + re-renders. See [[../libraries/ad-segments]], [[../lifecycles/ad-render]]. |
| `landing_url` | `text` | ✓ | default click-through destination for this ad (migration `20260615120000`). Set from the archetype→lander map at seed time; pre-fills the Meta publish panel; operator-overridable. See [[../lifecycles/ad-publish]], [[../specs/killer-statics]]. |
| `status` | `text` | — | default: `'draft'` · live values: `draft` \| `ready` \| `archived` (probe 2026-07-13). `archived` is the retire state — set when an ad's landing URL is removed (retiring/URL-removed). The [[../libraries/ready-to-test]] reader `.neq('status','archived')`s + guards the row-loop so retired creatives never count toward Dahlia's bin depth or media-buyer replenish. Historical values `rendering` \| `failed` appear in older pipeline records but are no longer produced. |
| `audience_temperature` | `text` | ✓ | Temperature band the creative was authored for. CHECK: `null` OR one of `cold` \| `warm` \| `hot`. NULL means untagged (existing rows + deterministic buildMetaCopy inserts). Dahlia's M1 keystone author session sets it per creative; the M3 variant-pack spec writes three temperature-banded variants against this same column. The Phase-2 gate in [[../libraries/creative-agent]] `insertReadyCreative` reads it and refuses a `cold` row whose composed copy trips `hasColdOfferLeak` in [[../libraries/lf8]]. Migration `20261022120000`. |
| `author_self_score` | `jsonb` | ✓ | Dahlia's author-mode self-score against the shared 0-10 Conversion-Psychology rubric (LF8 + Schwartz + Cialdini + Hopkins + Sugarman), stamped by [[../libraries/creative-agent]] `insertReadyCreative` when `DAHLIA_COPY_MODE=author` dispatched a copy-author box session that returned an ok verdict. Shape: `{ lf8:int, schwartz:int, cialdini:int, hopkins:int, sugarman:int, total:int, evidence:string[] }` — each sub-score is an integer in `{0,1,2}`; `total` equals the arithmetic sum (a mismatched sum is rejected at the `parseAuthorVerdict` layer, triggering a revise). NULL for deterministic `buildMetaCopyPack` inserts and pre-Dahlia rows (null-means-deterministic-mode). Read by the M1 Max QC + M3 measurement specs. Migration `20261023120000`. |
| `concept_tag` | `text` | ✓ | Andromeda concept-diversity token stamped by Dahlia's author box session on every ok verdict; CHECK: `null` OR one of `transformation` \| `objection` \| `curiosity` \| `mechanism` \| `authority` \| `social-proof` \| `scarcity` \| `negation` \| `story` \| `comparison`. NULL means untagged (deterministic `buildMetaCopyPack` inserts + pre-Phase-1 rows). Bianca's [[../libraries/media-buyer-agent]] replenish path reads this (Phase 2) to enforce test-cohort concept diversity — no more than one same-tag creative live per cohort so a same-concept win generalizes and a same-concept loss is attributable to concept, not execution. Backed by a partial index `(workspace_id, concept_tag) where concept_tag is not null` for the per-workspace live-tag Set read. Migration `20261024120000` (dahlia-andromeda-concept-diversity-tags Phase 1). |
| `max_qc_eligible` | `boolean` | ✓ | Max's copy-QC eligibility flag stamped by [[../libraries/creative-agent]] `insertReadyCreative` (via `buildAdCampaignInsertBody`). `TRUE` = postable (Max's copy-QC verdict cleared hard_gate_pass AND persuasion_score >= `MAX_QC_ELIGIBILITY_FLOOR` — **now 9** after [[../specs/bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate]] Phase 1 raised it from 7 — Bianca's [[../libraries/ready-to-test]] picks it up); `FALSE` = binned-but-ineligible (Max ran and rejected — the creative row exists + is visible on the detail page with Max's critiques, but Bianca's DB filter hides it from her postable list UNLESS `override_postable=true` overrules it); `NULL` = Max never ran (deterministic `buildMetaCopyPack` inserts + kill-switch-off + pre-Phase-2 legacy rows) — Bianca reads NULL identically to TRUE so today's byte-for-byte behavior is preserved. The `FALSE` state is authored by the always-bin path when Dahlia's self-heal loop exhausted on `outcome.maxCopyQcMissed=true` (Max was the only failing gate) — the CEO's rule: never waste a produced creative; only Max's ≥`MAX_QC_ELIGIBILITY_FLOOR` gates POSTABILITY, not existence. Additive column, no default, no CHECK. Migration `20261105120000` ([[../specs/max-qc-always-bins-ad-7of10-gates-only-bianca-postability]] Phase 2). |
| `override_postable` | `boolean` | ✓ | CEO manual postability override — [[../specs/bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate]] Phase 2. `TRUE` = post regardless of `max_qc_eligible` (CEO overruled Max on the ad detail page); `NULL` = no override in play (fall back to `max_qc_eligible`). There is no `FALSE` state — clearing the override nulls all five override columns together. Written by the owner/admin-only `/api/ads/campaigns/[id]/postability-override` route via the SDK chokepoint [[../libraries/postability-override]] (`setPostabilityOverride` / `clearPostabilityOverride`). Bianca's [[../libraries/ready-to-test]] widens the DB filter to `max_qc_eligible IS NULL OR max_qc_eligible=TRUE OR override_postable IS TRUE` so an active override surfaces the creative even when Max held it. The publish-gate ([[../libraries/media-buyer-publish-gate]] `evaluateMaxCopyQcAtPublish`) reads this record in parallel with Max's verdict and returns `ok:true` when `override_postable=true` — Max's real grade stays on the verdict row untouched (the Max-vs-CEO gap IS the tuning signal). Migration `20261106120000`. |
| `hold_flag` | `jsonb` | ✓ | **always-bin-held-creative-with-flags (CEO 2026-07-21)** — the red-flag payload for a HELD (binned-ineligible) creative: `{ gate, reason, human, attempts }`. When Dahlia's copy-author self-heal loop EXHAUSTS on ANY class (firewall / validator / self-score / Max), [[../libraries/creative-agent]] `insertReadyCreative` now bins the last-authored caption HELD (`max_qc_eligible=false`) + stamps this flag instead of discarding the whole session — the CEO reviews the near-miss, reads what tripped, fixes the one line, and approves (`override_postable`). Rendered as the `⚠ Held — Max flagged this as non-compliant` banner on the ad detail page (`/dashboard/marketing/ads/[id]`). NULL on every postable row. Migration `20261121120000`. |
| `headline` | `text` | ✓ | **held-creatives-persist-authored-copy-and-v3-stamps-to-the-draft Phase 1 (CEO 2026-07-22)** — the authored headline string persisted DIRECTLY on the campaign row (`== copy_pack.headlines[0]` when set by `buildAdCampaignInsertBody`). Companion to `primary_text` / `description` / `metadata.copy_pack` — so a HELD (`max_qc_eligible=false`) draft renders its caption on the ad detail page even when the sibling [[product_ad_angles]] insert missed (angle_id=null — the observed 2026-07-22 Ashwavana 102a218f case). Both the eligible AND held paths write these fields via the same builder; NULL for pre-Phase rows + deterministic-mode inserts that never supplied a MetaCopyPack. Migration `20261130120000`. |
| `primary_text` | `text` | ✓ | held-creatives-persist-authored-copy-and-v3-stamps-to-the-draft Phase 1 — authored primary text persisted directly on the row (`== copy_pack.primaryTexts[0]`). See `headline` above. Migration `20261130120000`. |
| `description` | `text` | ✓ | held-creatives-persist-authored-copy-and-v3-stamps-to-the-draft Phase 1 — authored description persisted directly on the row (`== copy_pack.description`). See `headline` above. Migration `20261130120000`. |
| `metadata` | `jsonb` | ✓ | held-creatives-persist-authored-copy-and-v3-stamps-to-the-draft Phase 1 — jsonb envelope carrying `{ copy_pack: MetaCopyPack }` so the framework-labelled variations render on the ad detail page without needing the `angle_id` join. Shape: `{ copy_pack: { headlines: string[], primaryTexts: string[], description: string, frameworks?: string[] } }`. Read by `GET /api/ads/campaigns/[id]` as the angle-shaped fallback when `angle_id` is NULL — the existing UI copy-render code path is unchanged. Migration `20261130120000`. |
| `override_score` | `integer` | ✓ | CEO's override score (usually `MAX_QC_ELIGIBILITY_FLOOR`, currently 9) — recorded next to Max's real `persuasion_score` on [[ad_creative_copy_qc_verdicts]] so the Max-vs-CEO gap is preserved as the tuning signal. `CHECK (override_score IS NULL OR override_score BETWEEN 0 AND 10)`. Migration `20261106120000`. |
| `override_reason` | `text` | ✓ | CEO's written rationale (required on set — the API returns `missing_reason` on an empty string). Sanitized + trimmed at the SDK chokepoint [[../libraries/postability-override]] `normalizeOverrideReason` (max 1000 chars). Surfaced on the ad detail page's CEO override card + echoed in the `ceo_postability_override_set` [[director_activity]] audit row. Migration `20261106120000`. |
| `override_by` | `uuid` | ✓ | `auth.users` id of the workspace owner/admin who set the override. Attribution only; not a FK (auth schema is not FK'd from public per Supabase convention). Migration `20261106120000`. |
| `override_at` | `timestamptz` | ✓ | Timestamp when the override was set (or last updated). Cleared to NULL on override clear. Migration `20261106120000`. |
| `is_exploit` | `boolean` | — | default: `false` · **[[../specs/media-buyer-explore-exploit-split-on-crown]] Phase 2** — `TRUE` when this row was inserted by [[../libraries/winning-creative-detect]] `amplifyWinner` via the winner-aware exploit-slot allocator (a clone of a crowned winner spawned by Bianca's replenish path). `FALSE` on every explore replenish + every fatigue-replenish + every pre-Phase-2 row (migration default). [[../libraries/media-buyer-agent]] `readCurrentLiveExploitCount` narrows on this flag so the replenish plan splits the live cohort into explore vs exploit counts and never double-counts an exploit slot as explore — the 2-explore / 2-exploit target holds pass-to-pass. Backed by a partial index `(workspace_id, product_id) where is_exploit = true` for the fast per-product exploit-count read. Migration `20261208120001`. |
| `source_crowned_adset_id` | `text` | ✓ | **[[../specs/media-buyer-explore-exploit-split-on-crown]] Phase 2** — the crowned winner (bare Meta adset id) this exploit clone came from — matches [[media_buyer_crowned_winners]] `test_meta_adset_id`. Written alongside `is_exploit=true` by `amplifyWinner` when the caller passes `sourceCrownedAdsetId`; NULL on every non-exploit row. Phase 3 uses this to attribute the exploit-origin test verdict back to its source winner (a `promising|crown` clone ⇒ [[../libraries/crowned-winners]] `recordExploitHit`; a `dud` already counted a strike at spawn). Backed by a partial index `(workspace_id, source_crowned_adset_id) where source_crowned_adset_id is not null` for the reverse lookup. A row with `is_exploit=true` and a null `source_crowned_adset_id` is MALFORMED — the `amplifyWinner` insert always writes both together. Migration `20261208120001`. |
| `exploit_hit_credited_at` | `timestamptz` | ✓ | **[[../specs/media-buyer-explore-exploit-split-on-crown]] Phase 3** — timestamp when this exploit clone's `promising|crown` verdict was credited back to its source winner via [[../libraries/crowned-winners]] `recordExploitHit`. NULL = never credited (pre-Phase-3 rows, live testing clones, `dud`/`testing` verdicts, and every non-exploit row). Set to `now()` by [[../libraries/media-buyer-agent]] `creditExploitHits` via a compare-and-set update (`.eq('id', row.id).eq('workspace_id', ws).eq('is_exploit', true).is('exploit_hit_credited_at', null).select('id')`) that transitions exactly one row per (clone, verdict) — a re-run reads zero rows and skips the SDK call entirely, so `exploit_hits` on the crown-marker never inflates and the `media_buyer_exploit_hit_credited` audit ledger never emits duplicates. Backed by a partial index `(workspace_id, product_id) where is_exploit = true and exploit_hit_credited_at is null` for the per-pass uncredited-clones sweep. Migration `20261209120000`. |
| `created_by` | `uuid` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `angle_id` → [[product_ad_angles]].`id`
- `avatar_id` → [[ad_avatars]].`id`
- `product_id` → [[products]].`id`
- `variant_id` → [[product_variants]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ad_videos]].`campaign_id`
- [[ad_jobs]].`campaign_id`
- [[storefront_sessions]].`ad_campaign_id` (Phase 2b)
- [[orders]].`ad_campaign_id` (Phase 2b)

## Stamp writers — the four v3 attribution columns

`creative_theme` / `angle_palette_id` / `headline_pattern_id` / `creative_combination_id` are the v3 attribution stamps the factor rollup + coverage ledger + theme-spread selector all read (migration `20261123120000` added the columns). [[../libraries/creative-agent]] `buildAdCampaignInsertBody` accepts an optional `v3Stamps: { creative_theme, angle_palette_id, headline_pattern_id, creative_combination_id }` param (held-creatives-persist-authored-copy-and-v3-stamps-to-the-draft Phase 1); `insertReadyCreative` threads it straight through so BOTH the eligible AND the held (`max_qc_eligible=false`) inserts write the same tuple onto the row. The M5 factor rollup uses `IS NOT NULL` on `creative_theme` as the "stamped" predicate — a HELD draft counts alongside eligible + posted rows.

When the caller does NOT thread `v3Stamps`, all four columns land NULL — the shape existing readers already tolerate. Deterministic-mode inserts + pre-Phase-3 rows are also NULL. The intended selector-driven caller flow (populated via [[../libraries/select-angle-pattern|`selectAnglePatternForBrief`]] + `upsertCombinationForPair` before the campaign insert, and the post-insert `markAngleUsed` + `bumpCombinationUsed` coverage bumps) lights up in [[../specs/wire-engine-into-dahlia-author-path]] Phase 2/3.

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ad_campaigns")
  .select("id, name, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("ad_campaigns")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

## Gotchas

- Enum values are **lowercase** (`status`).
- `avatar_id` is `ON DELETE SET NULL` — archiving/deleting an [[ad_avatars]] row leaves the campaign intact but avatar-less.
- `length_sec` is `15` or `30`. 30s ads render as **two** talking-head clips — see [[ad_videos]].`talking_head_segments_url`.
- Internal joins use UUIDs (`variant_id` → [[product_variants]].id, not `shopify_variant_id`).
- **`name` becomes the published Meta ad name** ([[../lifecycles/ad-publish]]) — keep **demographic/ethnicity terms out of it** (e.g. "(Black)", "(Latina)") or Meta may flag the ad. To tag which avatar a campaign uses, use the avatar's ID-prefix code instead: `(av-<first 4 of avatar_id>)`. The default name `${product} — ${hook_slug}` is already clean; ethnicity only creeps in via manual naming.
- **`audience_temperature` is nullable + CHECK-constrained.** NULL is the pre-Dahlia interpretation ("untagged" — deterministic buildMetaCopy leaves it NULL and the Phase-2 cold-offer gate passes those rows through). The DB refuses any value other than `cold` / `warm` / `hot` / `null`, so a stray write can't degrade the column into a free-form string. Dahlia sets it on author-mode inserts; the M1 Max QC + M3 variant pack both read the same column. Do not add an index — it is a per-row read at insert time, not a query filter.
- **`concept_tag` is the Andromeda taxonomy SSOT — CHECK-constrained to the 10 tokens or NULL.** Three sources must stay in lockstep: the migration's CHECK constraint (`20261024120000_ad_campaigns_concept_tag.sql`), the `ANDROMEDA_CONCEPT_TAGS` const in [[../libraries/creative-agent]] (used by `parseAuthorVerdict`), and the enum list in [[../../../.claude/skills/dahlia-copy-author/SKILL.md]]. A divergence would let a parser-valid tag fail the DB write (or vice-versa). Unlike `audience_temperature`, this column IS indexed (partial, `where concept_tag is not null`) — Bianca's replenish path reads it per replenish call to compute the live-tag Set for the current cohort. NULL is the "untagged" bucket (deterministic-mode + pre-Phase-1) and Phase-2's diversity gate never conflates it with any Andromeda token.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
