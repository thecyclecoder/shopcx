# ad_creative_copy_variants

Per-creative temperature-banded copy pack — one row per (ad_campaign_id, audience_temperature) for a single [[ad_campaigns]] row. Sibling table lets Dahlia's author-session persist THREE variants (cold · warm · hot) against the SAME image + brief so Meta's Advantage+ selector can route each variant to the correct audience. Storage keystone for [[../specs/dahlia-temperature-banded-multi-variant-copy-pack]] Phase 1.

**Why it exists:** [[ad_campaigns]] is 1:1 image:caption today; [[../libraries/creative-brief]] `buildMetaCopy` emits ONE `{primaryText, headline, description}` per creative. Under Advantage+, that means the same creative shows the same caption to cold + warm + hot audiences — the #1 DTC creative error since Advantage+ made the creative the audience selector (goal `dahlia-imitate-then-innovate-copy-engine` line 17). This table + the pack-shaped `AuthorModeCopy.variants` field + the [[../libraries/ad-copy-variants|writeCopyVariants]] chokepoint are the storage layer M3 needs.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `ad_campaign_id` | `uuid` | — | → [[ad_campaigns]].id · ON DELETE CASCADE |
| `audience_temperature` | `text` | — | `'cold' \| 'warm' \| 'hot'` (CHECK-constrained). Matches the vocabulary [[../libraries/creative-agent]] `resolveAudienceTemperature` emits. The UNIQUE constraint below enforces exactly-one variant per band per creative. |
| `headline` | `text` | — | Meta caption headline for THIS band (≤40 chars per Meta caps; enforced upstream in [[../libraries/creative-agent]]). |
| `primary_text` | `text` | — | Meta primary text for THIS band (curiosity/objection hook for cold; benefit + social proof for warm; offer + urgency for hot per the [[../../../.claude/skills/dahlia-copy-author/SKILL]] schema). |
| `description` | `text` | — | Meta description for THIS band. |
| `author_self_score` | `jsonb` | ✓ | Dahlia's per-variant self-score against the shared 0-10 Conversion-Psychology rubric, same shape as [[ad_campaigns]].`author_self_score`: `{ lf8, schwartz, cialdini, hopkins, sugarman, total, evidence[] }`. Nullable so a rare deterministic-mode caller can write a variant without a self-score (Phase 2 treats null as no-signal, not failure). |
| `claim_trace` | `jsonb` | ✓ | Witnessed-citation entries from [[../specs/dahlia-never-fabricate-copy-firewall]] — one per substantive claim in the caption. Nullable for the same reason as `author_self_score`. |
| `validator_pass` | `boolean` | — | True iff EVERY rail in the [[../libraries/copy-validator|M2 shared validator]] passed for THIS variant. Phase 2's per-variant revise loop reads this to decide whether to bounce ONLY this band (a cold `cold_offer_gate` failure never kills the warm/hot bands). |
| `validator_checks` | `jsonb` | — | Per-rail payload from `validateGeneratedCopy`: `[{ rail, pass, reason?, evidence? }, ...]`. Open jsonb (no shape CHECK) so a future rail lands without a migration; the .ts parser pins the shape. |
| `concept_tag` | `text` | ✓ | The [[../specs/dahlia-andromeda-concept-diversity-tags|Andromeda]] concept token Dahlia picked for THIS variant. Kept per-variant (not just on the parent [[ad_campaigns]] row) so a cold variant pivoting to a different concept from the warm one can carry its own tag. Nullable for deterministic-mode / single-variant callers. |
| `retry_index` | `int4` | — | default: `0` · attempt number for THIS band. Phase 2's per-variant revise loop increments up to `MAX_COPY_AUTHOR_REVISE_ATTEMPTS` (defined in [[../libraries/creative-agent]]). Bounded by the caller (not a CHECK) so exhaustion is a [[director_activity]] escalation, not a DB error. |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id` (ON DELETE CASCADE — workspace teardown removes the pack)
- `ad_campaign_id` → [[ad_campaigns]].`id` (ON DELETE CASCADE — campaign delete removes its variants)

## Constraints

- `UNIQUE (ad_campaign_id, audience_temperature)` — one variant per band per creative. This is the on-conflict target [[../libraries/ad-copy-variants|writeCopyVariants]] upserts against, so re-writing a pack is idempotent at the DB level (a Phase 2 per-variant revise landing ONLY the cold band overwrites the cold row rather than piling up drafts).

## Indexes

- `ad_creative_copy_variants_campaign_idx (ad_campaign_id)` — per-campaign read (the Phase 2 canonical-picker + the future publisher-asset-feed reader).
- `ad_creative_copy_variants_workspace_idx (workspace_id, created_at desc)` — workspace-wide read (newest-first) for the Growth dashboard + measurement queries.

## RLS

Mirrors [[ad_creative_copy_qc_verdicts]] · [[ad_campaigns]]:
- `ad_creative_copy_variants_service_all` — service role does all writes (per CLAUDE.md: writes go through `createAdminClient()`).
- `ad_creative_copy_variants_member_select` — any authenticated workspace member can select.

## Common queries

### Fetch the full pack for a creative
```ts
const { data } = await admin.from("ad_creative_copy_variants")
  .select("audience_temperature, headline, primary_text, description, validator_pass, retry_index")
  .eq("ad_campaign_id", adCampaignId)
  .order("audience_temperature", { ascending: true });
```

### Idempotent upsert of a temperature-banded pack (Phase 1 SDK)
```ts
import { writeCopyVariants } from "@/lib/ads/ad-copy-variants";
const { inserted } = await writeCopyVariants(admin, {
  adCampaignId,
  workspaceId,
  variants: authorModeCopy.variants ?? [],
});
```

## Gotchas

- **Writes go through the SDK helper.** Never raw `.from("ad_creative_copy_variants").insert/upsert(...)` — the SDK-chokepoint rule (CLAUDE.md · [[../operational-rules]]) applies here too. The Phase 1 helper is [[../libraries/ad-copy-variants|`writeCopyVariants`]] in `src/lib/ads/ad-copy-variants.ts`. It batches an UPSERT on `UNIQUE (ad_campaign_id, audience_temperature)` so re-writing the same pack is safe.
- **The parent [[ad_campaigns]] row still stamps the CANONICAL variant.** `insertReadyCreative` picks the canonical via [[../libraries/creative-agent|`pickCanonicalVariant`]] (warm > cold > hot priority) and stamps its headline/primaryText/description/audience_temperature/author_self_score on the parent row so single-caption readers do not break. Reading only [[ad_campaigns]] gets the canonical variant; reading this table gets the full pack.
- **Canonical priority is warm > cold > hot on purpose.** Warm covers the widest audience slice on Advantage+ and reads as the safest single-caption fallback. Cold hooks are curiosity/objection (not always a durable claim); hot leads with offer + urgency and would misfire on a cold single-caption fallback.
- **`retry_index` is bounded by the caller, not a CHECK.** `MAX_COPY_AUTHOR_REVISE_ATTEMPTS` lives in [[../libraries/creative-agent]]. Exhaustion is a [[director_activity]] escalation (`action_kind='dahlia_partial_variant_pack'` — Phase 2), not a DB error.
- **Empty variants is a valid no-op.** The Phase 2 deterministic front-half can narrow `target_temperatures` (e.g. `['warm']` for a retention-lookalike run); if the resulting pack is empty (all bands exhausted), `writeCopyVariants` writes 0 rows and returns `{inserted:0}` rather than throwing. Whether the whole creative escapes depends on the M1 keystone's `dahlia_copy_author_exhausted` path (unchanged in Phase 1).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]] · [[../specs/dahlia-temperature-banded-multi-variant-copy-pack]] · [[../libraries/creative-agent]] · [[../libraries/ad-copy-variants]]
