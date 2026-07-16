# product_ad_angles

Generated ad angles per product — each row is one hook × Life Force 8 slot, anchored to a verbatim lead benefit. Consumed by the ad tool to script [[ad_campaigns]] and [[ad_videos]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `hook_slug` | `text` | — | one of 12 hook formulas: `problem_now` \| `contrarian` \| `results_first` \| `callout` \| `enemy` \| `secret_reveal` \| `urgent_question` \| `social_proof_shock` \| `visual_shock` \| `story_in_progress` \| `keeping_up` \| `loved_one_at_risk` |
| `lf8_slot` | `int4` | — | CHECK 1..8 (Life Force 8) |
| `lead_benefit_anchor` | `text` | — | NOT NULL · **verbatim** from [[product_page_content]].`benefit_bar[].text` OR [[product_benefit_selections]].`benefit_name` — the anchoring contract |
| `pain_now` | `text` | ✓ |  |
| `desired_outcome` | `text` | ✓ |  |
| `hook_one_liner` | `text` | ✓ | ≤15 words |
| `proof_anchor` | `jsonb` | ✓ | `{type:'review'\|'science'\|'award'\|'stat', value, source_id?}` |
| `urgency_lever` | `text` | — | default: `'none'` · `limited_batch` \| `selling_out` \| `price_increase_soon` \| `seasonal` \| `none` |
| `enemy` | `text` | ✓ |  |
| `vibe_tags` | `text[]` | ✓ | `ugly` \| `loud` \| `weird` \| `phone_recorded` \| `clinical` |
| `meta_headline` | `text` | ✓ | CHECK ≤40 chars |
| `meta_primary_text` | `text` | ✓ | CHECK ≤125 chars |
| `meta_description` | `text` | ✓ | CHECK ≤30 chars |
| `generated_by` | `text` | — | default: `'ai'` · `ai` \| `agent` \| `imported` |
| `times_used` | `int4` | — | default: `0` |
| `last_performance` | `jsonb` | ✓ |  |
| `is_active` | `bool` | — | default: `true` |
| `status` | `text` | — | default: `'approved'` · CHECK in (`proposed`, `approved`, `archived`) — voice-mined candidates land at `proposed` and flip to `approved` on Director sign-off |
| `metadata` | `jsonb` | — | default: `'{}'` · voice-mining provenance: `{mined_from:{review_ids,cancel_event_ids,ticket_ids}, matrix_overlap, density, score, mechanism_claim, offer}`; Dahlia's finished creative pack ([[../libraries/creative-pack]]) stamps `{copy_pack:{headlines:[...4], primaryTexts:[...4], description}}` here so Bianca's publish path can read the full 4×4 copy pack without a new column |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

Indexes: `product_ad_angles_active_lookup_idx (workspace_id, product_id, created_at DESC) WHERE is_active` · `product_ad_angles_proposed_idx (workspace_id, product_id, created_at DESC) WHERE status='proposed'`.

## Foreign keys

**Out (this → others):**

- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ad_campaigns]].`angle_id`

## Common queries

### List active angles for a product
```ts
const { data } = await admin.from("product_ad_angles")
  .select("id, hook_slug, lf8_slot, lead_benefit_anchor, hook_one_liner")
  .eq("workspace_id", workspaceId)
  .eq("product_id", productId)
  .eq("is_active", true)
  .order("created_at", { ascending: false });
```

### Count since a given time
```ts
const { count } = await admin.from("product_ad_angles")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Enum values are **lowercase** (`hook_slug`, `urgency_lever`, `vibe_tags`, `generated_by`).
- `lead_benefit_anchor` must be **verbatim** from [[product_page_content]] or [[product_benefit_selections]] — never paraphrased. This is the anchoring contract that ties an angle to a real, approved claim.
- `meta_headline` / `meta_primary_text` / `meta_description` are length-capped by CHECK constraints (40 / 125 / 30) — inserts that exceed them fail at the DB.
- **Re-runs archive, never overwrite:** `generateAngles()` flips prior active rows to `is_active=false`, then appends fresh rows. Read with `WHERE is_active`.
- Written by `generateAngles()` in `src/lib/ad-angles.ts` (the tier-1..5 product-intel pipeline → `status='approved'` + `is_active=true`).
- Also written by `persistProposedAngles()` in `src/lib/ads/customer-voice-mining.ts` (the customer-voice → ad-angles synthesizer) → `status='proposed'`, `is_active=false`, `generated_by='agent'`. The Phase-3 Director sweep is what flips those to `approved` and turns on `is_active`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
