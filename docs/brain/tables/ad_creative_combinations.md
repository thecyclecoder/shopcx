# ad_creative_combinations

The **coverage ledger at the freshness grain** — one row per `(angle × pattern)`, the thing that becomes an ad. This is the creative engine's "never ship the same ad twice" memory: `times_used`/`last_used_at`/`status` drive cooldown + coverage-before-repetition, and the `campaign_id` link closes the loop back to performance.

The combination = an [[product_angle_palette]] angle × an [[ad_headline_patterns]] pattern. The angle and pattern each carry their OWN coverage; this ledger tracks the specific pairing that got posted.

**Primary key:** `id` · **Unique:** `(workspace_id, angle_id, pattern_id)`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · `on delete cascade` |
| `product_id` | `uuid` | — | → [[products]].id · `on delete cascade` |
| `angle_id` | `uuid` | — | → [[product_angle_palette]].id · `on delete cascade` |
| `pattern_id` | `uuid` | — | → [[ad_headline_patterns]].id · `on delete cascade` |
| `times_used` | `int4` | — | default `0` · **coverage** — bumped when this pairing ships |
| `last_used_at` | `timestamptz` | ✓ | **freshness** — drives the ~30–45d cooldown |
| `status` | `text` | — | default `'fresh'` · CHECK `fresh`\|`tested`\|`crowned`\|`retired` |
| `campaign_id` | `uuid` | ✓ | → [[ad_campaigns]].id (`on delete set null`) — last/representative campaign, the perf link |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`
- `product_id` → [[products]].`id`
- `angle_id` → [[product_angle_palette]].`id`
- `pattern_id` → [[ad_headline_patterns]].`id`
- `campaign_id` → [[ad_campaigns]].`id` (`on delete set null`)

**In (others → this):**

- [[ad_campaigns]].`creative_combination_id` → this.`id` (the attribution stamp)

## Writers

All reads/writes route through the [[../libraries/creative-combinations]] SDK — never raw `.from('ad_creative_combinations')` outside that file (shopcx no-raw-`.from()` rail).

- **`listCombinationsForProduct(admin, {workspaceId, productId, status?})` → `Promise<CreativeCombination[]>`** — the READ chokepoint the [[../libraries/selection-engine]] leans on. Returns every ledger row for `(workspace_id, product_id)`, optionally narrowed to a `status` (typically `'fresh'`). The selector applies cooldown / palette-join / pattern-fillability filters in memory. Landed by [[../specs/selection-engine-coverage-ledger]] Phase 1.
- **`upsertCombinationForPair(admin, {workspaceId, productId, angleId, patternId})` → `Promise<string>`** — *(wire-engine Phase 3)* idempotent upsert on the unique key `(workspace_id, angle_id, pattern_id)`, returns the combination id. Called by [[../libraries/creative-agent]] `insertReadyCreative` BEFORE the [[ad_campaigns]] insert so the row's `creative_combination_id` FK is real.
- **`bumpCombinationUsed(admin, combinationId, nowIso, campaignId)` → `Promise<void>`** — *(wire-engine Phase 3)* read-then-write bump of `times_used` + set `last_used_at` + set `campaign_id` (the perf link). Called by `insertReadyCreative` AFTER the campaign insert, alongside [[../libraries/angle-palette]] `markAngleUsed` — the pair advances both sides of the coverage ledger in one call site.

Reads are wired by [[../specs/selection-engine-coverage-ledger]] Phase 1; writers land with [[../specs/wire-engine-into-dahlia-author-path]] Phase 3. The M4 selection-ledger + freshness-cooldown spec's Phase 2 picker sharpens WHICH combination the selector picks without changing this writer surface.

## Common queries

### Fresh combinations for a product not on cooldown
```ts
const cooldownIso = new Date(Date.now() - 45 * 864e5).toISOString();
const { data } = await admin.from("ad_creative_combinations")
  .select("id, angle_id, pattern_id, times_used, last_used_at, status")
  .eq("workspace_id", workspaceId)
  .eq("product_id", productId)
  .eq("status", "fresh")
  .or(`last_used_at.is.null,last_used_at.lt.${cooldownIso}`);
```

## Gotchas

- **This is the ad grain.** The angle and the pattern each have their own `times_used`/`status`; this row tracks the specific pairing. Selection rule: coverage-before-repetition (spend unused combinations before repeating one), never repeat a combination within the cooldown, and the pool never starves — Dahlia's fan-out mints new angles (new `product_angle_palette` rows) when fresh combinations deplete.
- **Note the status enum differs from the angle's.** Combinations use `fresh`\|`tested`\|`crowned`\|`retired` (`tested`, past tense); [[product_angle_palette]].status uses `fresh`\|`testing`\|`crowned`\|`retired` (`testing`, present). Probe before assuming.
- **`campaign_id` is `on delete set null`** — a deleted campaign leaves the coverage memory intact (the pairing was still used), just severs the perf link.
- **Attribution loop.** The `campaign_id` link + [[ad_campaigns]]'s reciprocal `creative_combination_id` stamp let the factor-rollup join Meta results back to `{theme, angle, pattern, combination}` and re-weight selection (exploit crowned winners, down-weight losers, keep exploring). See the v3 model in [[../libraries/compose-headline]].

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
