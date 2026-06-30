# libraries/ads/customer-voice-mining

Customer-voice-to-ad-angles synthesizer: mines captured customer voice (reviews, cancellations, support tickets) → synthesizes angle candidates via LLM → persists scored proposals to [[../tables/product_ad_angles]] → Director approves and fans into [[../lifecycles/ad-static]] / [[../lifecycles/ad-render]]. Closes the 'customer voice → ads' half of the performance→creative loop.

**File:** `src/lib/ads/customer-voice-mining.ts` · Test: `src/lib/ads/customer-voice-mining.test.ts` (`npm run test:customer-voice-mining`). **Owner:** [[../functions/growth]] · **Mandate:** Performance→creative loop.

## Three-phase flow

**Phase 1 — Voice mining (pure read):** Extract customer signals from [[../tables/product_reviews]], [[../tables/customer_events]] (cancellations), [[../tables/tickets]] (support themes) → typed `VoiceFragment[]` array. No LLM, safe to run repeatedly.

**Phase 2 — Synthesize + score (LLM once):** Pass fragments + [[../libraries/creative-skeleton]] pattern matrix to Opus → emit K candidate angles `{hook, mechanism_claim, proof, offer, supporting_fragment_ids:[]}`. Score by cross-brand overlap + fragment density. Persist accepted to [[../tables/product_ad_angles]] at `status='proposed'`.

**Phase 3 — Director approval → hand-off:** [[../functions/growth]] Director reviews proposed angles on the brief; on approve, flip `status='approved'` + enqueue static/video render request to [[../lifecycles/ad-static]] or [[../lifecycles/ad-render]] and write `director_activity` row (`action_kind='approved_voice_angle'`).

## Exports

### `mineCustomerVoice` — function

```ts
function mineCustomerVoice(
  admin: SupabaseAdmin,
  opts: { workspaceId: string; productId: string; sinceMs?: number },
): Promise<{ fragments: VoiceFragment[] }>
```

Default `sinceMs` is 90 days. Each fragment carries `{ source, source_id, text, signal }` so a downstream pass can write `metadata.mined_from: { review_ids:[], cancel_event_ids:[], ticket_ids:[] }` to `product_ad_angles`.

### `synthesizeAdAngles` — function (Phase 2)

```ts
function synthesizeAdAngles(opts: {
  fragments: VoiceFragment[];
  patternMatrix: CreativePatternMatrix;
  productId: string;
}): Promise<{ candidates: AdAngleCandidate[] }>
```

Calls Opus once with fragments + pattern matrix → emits K angle candidates. Each candidate carries `{hook_slug, mechanism_claim, proof, offer, supporting_fragment_ids[], score, matrix_overlap}`. Scores determined by (a) cross-brand pattern overlap and (b) supporting fragment density. Calls `persistProposedAngles()` to write results to `product_ad_angles` at `status='proposed'`.

### `persistProposedAngles` — function (Phase 2)

Writes synthesized candidates to [[../tables/product_ad_angles]] with `status='proposed'`, `is_active=false`, `generated_by='agent'`, carrying `metadata={mined_from:{review_ids:[], cancel_event_ids:[], ticket_ids:[]}, matrix_overlap, score}`.

### `VoiceFragment` — type

```ts
type VoiceSignal = "positive" | "objection" | "use_case";
type VoiceSource = "product_reviews" | "customer_events" | "tickets";
interface VoiceFragment {
  source: VoiceSource;
  source_id: string;
  text: string;
  signal: VoiceSignal;
}
```

## Sources & signals

| Source table | Signal | Filter |
|---|---|---|
| [[../tables/product_reviews]] | `positive` | `workspace_id` + `product_id` + `rating>=4` + non-null `body`, since-window. `smart_quote` wins over `body` as the fragment text. |
| [[../tables/customer_events]] | `objection` | `workspace_id` + `event_type='portal.subscription.cancel_reason'`, since-window. Text = `properties.reasonLabel` → `properties.reason` → parsed from `summary` ("Cancel reason selected: {label}"). Written by [[portal__handlers__cancel-journey]]. |
| [[../tables/tickets]] | `use_case` | `workspace_id` + `merged_into IS NULL` + non-null `subject`, since-window. For each ticket, joins the latest [[../tables/ticket_analyses]] `summary` and prefers it over `subject` when present. |

## Gotchas

- **Schema reality vs spec wording.** The spec references a `subscription_events` table and `tickets.summary` — neither exists on main. The cancel-flow reason is recorded on [[../tables/customer_events]] (event_type `portal.subscription.cancel_reason`) by [[portal__handlers__cancel-journey]]; the AI ticket summary lives on [[../tables/ticket_analyses]]`.summary`. This reader uses the real tables.
- **Workspace-scoped, not product-scoped, for two sources.** `customer_events` (cancel) and `tickets` have no `product_id` FK today, so they are workspace-scoped only. The Phase 2 LLM synthesizer is responsible for relevance-scoring these fragments against the named `productId`.
- **`smart_quote` is the preferred review text** — Klaviyo extracts a ≤15-word highlight that reads as ad copy. Falls back to `body` when null.
- **No writes, no side-effects.** Pure SELECT; safe to run per Director sweep.

## Callers

- **Phase 2 synthesizer:** `scripts/builder-worker.ts` orchestrator job (scheduled or manual trigger) calls `mineCustomerVoice()` + `synthesizeAdAngles()` → persists proposed angles to [[../tables/product_ad_angles]].
- **Phase 3 director sweep:** [[../functions/growth]] Growth Director session (via `/dashboard/`) reviews `product_ad_angles.status='proposed'` angles; on approve, flips to `approved` + enqueues `ad-tool/static-requested` or `ad-tool/video-requested` events to [[../inngest/ad-tool]] (kickstarts [[ad-static]] or [[ad-render]] generation) + writes `director_activity` row.

---

[[../README]] · [[../../CLAUDE]]
