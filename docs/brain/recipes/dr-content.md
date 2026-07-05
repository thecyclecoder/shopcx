# Reuse existing product_media before opening a real-evidence content gap

Carrie's DR-content lane fills a queued [[../tables/lander_blueprints]] row's `content` bucket
block-by-block ([[../libraries/builder-worker]] `runDrContentJob`, skill
`.claude/skills/dr-content/SKILL.md`). Per image slot Carrie emits a per-slot verdict — `generate`
(the worker calls Nano Banana Pro) or `flag_gap` (the worker opens a
[[../tables/lander_content_gaps]] row for the founder). Real-evidence categories (`before_after` /
`ugc` / `testimonial_photo` / `press_logo`) are always `flag_gap` — a generated selfie / before/after
is a fabricated customer result, which is the whole reason this lane exists as a supervised leash.

**But** before the worker opens a gap for a real-evidence slot, it probes for an EXISTING product
asset that already satisfies the slot — categorized during a prior Carrie pass OR named that way
via the legacy `slot` / `alt_text` vocabulary. On a hit the worker references the existing media
in the blueprint `content` bucket and skips the gap; on a miss it opens the gap as before. This is
the reuse-before-flag rule — it keeps Carrie's compliance line intact (she never fabricates a
customer result) AND stops re-asking the founder for assets we already own.

## Helper to call

[[../libraries/lander-blueprints]] `findExistingRealAsset(workspaceId, productId, assetRole)` —
`src/lib/lander-blueprints.ts`. The single SDK chokepoint for the reuse probe; the worker calls
it in `runDrContentJob` per real-evidence slot before the `openContentGap` fallback.

## Params

| Name | Type | Notes |
|---|---|---|
| `workspaceId` | `string` (UUID) | Workspace scope — every read is `.eq('workspace_id', workspaceId)`. |
| `productId` | `string` (UUID) | The blueprint's product. Reuse is per-product; a `before/after` on Amazing Coffee cannot satisfy Focus Blend. |
| `assetRole` | `"before_after" \| "ugc" \| "testimonial_photo" \| "press_logo"` | The real-evidence category the block needs. The four `REAL_EVIDENCE_CATEGORIES` in [[../libraries/lander-blueprints]]. |

Return: `ProductMediaCategorizedRow | null` — a subset of the [[../tables/product_media]] row
(`id`, `slot`, `url`, `category`, `source`, `alt_text`, `caption`, …) if a match, else `null`.

## Match rules (in order)

1. **Category match** — `category = assetRole`. A row Carrie's DR-content pass already
   categorized (or the founder resolved a prior [[../tables/lander_content_gaps]] row into).
   Wins over any slot match.
2. **Slot / alt semantic match** — for any still-uncategorized row (historic uploads that pre-date
   the DR columns), fall back to the legacy `slot` / `alt_text` vocabulary:
   - `before_after` ← `slot` matches `before` / `after` / `before_{n}` / `after_{n}`
   - `press_logo` ← `slot` = `press` or `slot` starts with `press_`
   - `testimonial_photo` ← `slot` matches `endorsement_*_avatar`
   - `ugc` ← `slot` or `alt_text` contains `ugc` / `selfie` / `customer`

Both paths REQUIRE `source <> 'generated'` — the never-fake-a-customer-result compliance rail. An
AI-generated image can never satisfy a real-evidence slot even if its category matches. Rows with
`source IS NULL` (historic uploads written before the DR columns landed) are treated as
non-generated and eligible.

## Minimal example — the call site

```ts
// scripts/builder-worker.ts — runDrContentJob's per-slot loop, real-evidence branch
if (DR_CONTENT_REAL_EVIDENCE_CATEGORIES.has(assetRole)) {
  if (slot.kind === "generate") {
    refused++;
    console.warn(`${tag} refused generate on real-evidence category '${assetRole}' — routing to gap instead`);
  }
  const existing = await findExistingRealAsset(
    job.workspace_id,
    productId,
    assetRole as "before_after" | "ugc" | "testimonial_photo" | "press_logo",
  ).catch(() => null);
  if (existing?.url) {
    assets.push({ kind: "image_ref", ref: existing.url });
    reused++;
    continue;
  }
  await openContentGap({ workspace_id: job.workspace_id, blueprint_id: blueprint.id, asset_role: assetRole, block_ref: role, description });
  flagged++;
  assets.push({ kind: "gap", ref: assetRole });
}
```

Net effect on an Amazing-Coffee-style blueprint (product already owns `before` / `after` +
`press_*` media, categorized OR by slot): Carrie's session still emits `flag_gap` for every
real-evidence slot, but the worker OPENS gaps only for the genuinely-missing assets (e.g.
certification badges + a UGC selfie) — before/after + press logos are reused and referenced in
the content bucket as `{kind:'image_ref', ref:<url>}`.

## Gotchas

- **Never satisfies with `source='generated'`.** Not "prefers not to" — a hard filter. The SDK
  drops generated rows before the category / slot match runs. Even a `category='before_after'`
  row written by another lane with `source='generated'` cannot stand in. This is the compliance
  rail; a fabricated customer OUTCOME is the harm the lane is designed to prevent.
- **Categorized match wins over slot match.** If a product has both a `category='press_logo'` row
  AND a `slot='press_logo_1'` row, the categorized one is returned — it's the newer / DR-tagged
  path. Order-by-`created_at desc` breaks category ties (newest wins).
- **`ugc` slot heuristic is broad.** Any product_media row whose slot or alt_text contains `ugc`,
  `selfie`, or `customer` is a UGC candidate — matches real customer-supplied stills that were
  uploaded via a seed script under a non-DR slot. If a product has an unrelated `slot='customer_favorites'`
  (a hypothetical), it would false-positive; the fix is to categorize that slot correctly (write
  `category='other'` via [[../libraries/lander-blueprints]] `writeCategorizedProductMedia`), not
  to narrow the heuristic here.
- **Per-product, per-workspace.** No cross-product reuse — a Focus Blend before/after can't
  satisfy an Amazing Coffee slot, even in the same workspace. The workspace_id + product_id
  scope is the belt+suspenders (the RLS on `product_media` would enforce workspace regardless).
- **Prompt-side `mediaSummary` is NOT the gate.** The bundle Carrie sees in her prompt still
  includes categorized product_media (so she can reference by URL in a `caption`), but her verdict
  does not decide reuse — the WORKER decides via `findExistingRealAsset` after her verdict lands.
  Even if Carrie emits `flag_gap` for a slot we already own, the worker suppresses the gap.

## Related

- [[../libraries/lander-blueprints]] — the SDK chokepoint (`findExistingRealAsset`,
  `writeCategorizedProductMedia`, `openContentGap`, `listContentGaps`, `setBlueprintContent`,
  `setBlueprintStatus`).
- [[../libraries/builder-worker]] — the box worker's `runDrContentJob` (§ The `dr-content` lane).
- [[../tables/product_media]] — the categorized DR content STORE (columns `category`, `source`,
  `caption`, `slot`, `alt_text`).
- [[../tables/lander_content_gaps]] — the real-evidence flag store (`asset_role`, `block_ref`,
  `description`, `status`, `resolved_media_id`).
- [[../tables/lander_blueprints]] — the queued row Carrie fills.
- `.claude/skills/dr-content/SKILL.md` — Carrie's persona + real-vs-AI discipline (§ Reuse-before-flag).
- [[../specs/carrie-dr-content]] — the parent DR-content spec.
