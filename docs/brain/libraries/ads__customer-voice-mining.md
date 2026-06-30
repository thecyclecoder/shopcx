# libraries/ads/customer-voice-mining

Phase 1 of [[../specs/growth-customer-voice-to-ad-angles]] — a pure-read mining pass that turns captured customer voice into typed `VoiceFragment[]` for a workspace+product. NO LLM call; the Phase 2 synthesizer consumes this output to score angle candidates into [[../tables/product_ad_angles]].

**File:** `src/lib/ads/customer-voice-mining.ts` · Test: `src/lib/ads/customer-voice-mining.test.ts` (`npm run test:customer-voice-mining`).

## Exports

### `mineCustomerVoice` — function

```ts
function mineCustomerVoice(
  admin: SupabaseAdmin,
  opts: { workspaceId: string; productId: string; sinceMs?: number },
): Promise<{ fragments: VoiceFragment[] }>
```

Default `sinceMs` is 90 days. Each fragment carries `{ source, source_id, text, signal }` so a downstream pass can write `metadata.mined_from: { review_ids:[], cancel_event_ids:[], ticket_ids:[] }` to `product_ad_angles`.

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

_None yet — Phase 2 (`synthesizeAdAngles`) of the same spec will be the first caller._

---

[[../README]] · [[../../CLAUDE]]
