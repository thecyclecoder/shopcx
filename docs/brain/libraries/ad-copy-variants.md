# ad-copy-variants

The SDK chokepoint for [[../tables/ad_creative_copy_variants]] — the temperature-banded per-creative pack (dahlia-temperature-banded-multi-variant-copy-pack Phase 1) is written ONLY through `writeCopyVariants`. Raw `.from("ad_creative_copy_variants").insert/upsert(...)` anywhere in `src/` is a CLAUDE.md 'raw `.from(...)` with no SDK → STOP' violation.

**Source:** `src/lib/ads/ad-copy-variants.ts` · **Callers:** [[creative-agent]] `insertReadyCreative` (Phase 1) + [[creative-agent]] stockProduct's author-mode branch (Phase 2 will use it directly).

## Exports

### `writeCopyVariants(admin, opts): Promise<{inserted:number}>`

Persist a temperature-banded pack. Idempotent by design: the upsert targets `UNIQUE (ad_campaign_id, audience_temperature)` so re-writing the same pack yields the same rows (a Phase 2 per-variant revise landing ONLY the cold band overwrites the cold row rather than piling up drafts).

- `opts.adCampaignId` — parent [[../tables/ad_campaigns]].id the pack belongs to.
- `opts.workspaceId` — the workspace UUID (stamped on every row + used by RLS).
- `opts.variants` — `readonly AuthorModeCopyVariant[]`. Empty is a valid no-op (returns `{inserted:0}`); non-empty issues one upsert with N rows.

Fails LOUDLY on a driver-level error (throws) — a silent skip would erase the audit trail M3's success metric depends on.

### Types (re-exported from [[creative-agent]])

- `AuthorModeCopyVariant` — one temperature-banded entry: `{audience_temperature, headline, primaryText, description, selfScore, claim_trace, concept_tag, validatorPass, validatorChecks, retryIndex?}`.
- `pickCanonicalVariant(variants) → AuthorModeCopyVariant | null` — canonical picker for the parent [[../tables/ad_campaigns]] row. Priority is **warm > cold > hot**: warm is the widest single-caption fallback on Advantage+, cold hooks are curiosity/objection (not always durable claims), hot leads with offer + urgency (would misfire as a cold single-caption fallback). Pure — a unit test pins every branch.

## Invariants

- **UNIQUE (ad_campaign_id, audience_temperature) is the on-conflict target.** Any writer that changes it must change the migration + the brain page + the tests together.
- **The parent [[../tables/ad_campaigns]] row still stamps the CANONICAL variant.** [[creative-agent]] `insertReadyCreative` picks it via `pickCanonicalVariant` and stamps its headline/primaryText/description/audience_temperature/author_self_score on the parent row so single-caption readers do not break.
- **Empty variants is a no-op, not a throw.** Phase 2's deterministic front-half can narrow `target_temperatures` (e.g. `['warm']`) or land no surviving variants after per-variant revise exhaustion — the SDK writes zero rows and the caller decides whether to skip the creative entirely (via the M1 `dahlia_copy_author_exhausted` path).

---

[[../README]] · [[creative-agent]] · [[../tables/ad_creative_copy_variants]] · [[../specs/dahlia-temperature-banded-multi-variant-copy-pack]]
