# libraries/growth-director-hypotheses

Phase 2 of [[../specs/growth-director-analytical-brief]] — the **pure hypothesis generator** the Growth Director reads before deciding its next experiment. Runs read-only over the Phase-1 [[growth-director-analytical-brief]] scorecard, emits diagnostic hypotheses with cited evidence + confidence, and refuses tiny-sample calls via the SAME media-buyer $50 verdict-floor discipline. **The WORKER (deterministic Node) is the only mutator** — this module never writes a DB row.

**File:** `src/lib/agents/growth-director-hypotheses.ts` · Reads the Phase-1 result shape (`AnalyticalBriefResult`) directly — no additional DB fetches, no side effects, pure over the input.

## The four diagnostic reads

| `HypothesisKind` | Grain | Fires when |
|---|---|---|
| `funnel_not_creative` | per-creative | CTR ≥ **healthy floor** (1.0%) AND landing_page_views past **min-LPV** floor (30) AND **LPV→ATC** < **cliff floor** (5%). The 2026-07-08 live-read Tabs pattern the spec calls out — "the creative is doing its job; the destination isn't." |
| `format_effectiveness` | per-cohort | ≥2 variants past the min-spend floor (excluding `(unresolved)`) AND top-variant ROAS ≥ **1.5× bottom-variant ROAS**. The "advertorial wins for Coffee, before/after loses for Tabs" per-product signal Dylan noticed on the 2026-07-08 live read. |
| `delivery_anomaly` | per-creative | CPM ≥ **$50** (`SIGNAL_HIGH_CPM_CENTS`) OR frequency ≥ **4.0** (`SIGNAL_FATIGUE_FREQUENCY`). Auction / audience-saturation signal — the binding constraint isn't the creative or the destination. |
| `audience_signal` | per-cohort | ≥2 creatives past the funnel gate AND cohort-wide CVR (purchases ÷ LPV) < **1%** AND mean CTR ≥ **healthy floor**. "Traffic is arriving, it just isn't converting" — audience/interest is the story, not the ads. |

Every hypothesis carries **`evidence: HypothesisEvidence[]`** (each row is `{field, value, threshold?}` so the Director quotes real numbers, not vibes) and **`confidence: 'medium' | 'high'`** (`high` when every relevant metric is ≥3× its floor; `medium` at the floor; below the floor emits nothing).

## Sample gate (the media-buyer $50 verdict-floor discipline)

Below the floor a creative NEVER produces a call — instead it lands on `belowFloor` with the SPECIFIC gate that filtered it (`"sample gate — spend $8.00 < min $50.00, impressions 100 < min 500, landing_page_views 5 < min 30"`) so the Director's verdict can narrate the skip verbatim.

| Const | Default | Applies to |
|---|---|---|
| `DEFAULT_MIN_SPEND_CENTS` | 5_000 ($50) | funnel, delivery, format, audience |
| `DEFAULT_MIN_IMPRESSIONS` | 500 | funnel, delivery |
| `DEFAULT_MIN_CLICKS` | 20 | reserved for future signals |
| `DEFAULT_MIN_LANDING_PAGE_VIEWS` | 30 | funnel, audience |

Mirrors [[../ads/winning-creative-detect]] `DEFAULT_MIN_SPEND_CENTS` — the same $50 floor the winner-detector uses to refuse noisy ROAS reads. Every default is overridable per call via `opts.gate` for tests / a workspace-specific tune.

## Exports

- **`generateGrowthHypotheses(brief, opts?)`** → `HypothesesResult` = `{ hypotheses: Hypothesis[], belowFloor: BelowFloorEntry[], gate: SampleGate }`. Pure + deterministic (a fixed brief always returns the same hypotheses). Unresolved-cohort creatives (`cohort === UNKNOWN_COHORT`) NEVER emit — they land on `belowFloor` with reason `unknown_cohort` so the Director doesn't reason about attribution-less ads.
- **Named constants** — `DEFAULT_MIN_*` (sample gates), `SIGNAL_HEALTHY_CTR_PCT`, `SIGNAL_CLIFF_LPV_TO_ATC_RATE`, `SIGNAL_LOW_COHORT_CVR`, `SIGNAL_FORMAT_ROAS_MULTIPLIER`, `SIGNAL_FATIGUE_FREQUENCY`, `SIGNAL_HIGH_CPM_CENTS`.
- **Types** — `Hypothesis`, `HypothesisKind`, `HypothesisConfidence`, `HypothesisEvidence`, `BelowFloorEntry`, `HypothesesResult`, `SampleGate`, `GenerateHypothesesOptions`.

## Gotchas

- **Read-only reasoning; the WORKER persists.** The module returns typed data — never touches DB. The Phase-3 dispatcher (spec § Phase 3) is what routes each hypothesis into `storefront-experiments` / creative-maker / a new ad set at draft/proposed status.
- **`(unresolved)` variants are skipped in `format_effectiveness`** — same reason [[meta_attribution_daily]] mirrors: the sentinel is an attribution miss, not a real format. Callers who need the miss surfaced read it on the Phase-1 `variants` array directly.
- **`confidence='low'` is intentionally NOT emitted** — below the floor is `belowFloor`, at the floor is `medium`, well above is `high`. Distilling weak signals to `low` was tried once ([[../operational-rules]] § "no rubber-stamps") and led to Director verdicts that cited noise; the two-tier confidence keeps the citation crisp.
- **A single-creative CVR miss is a creative-level story, not an audience-level one.** `audience_signal` gates on `qualifying_creatives >= 2` deliberately — one bad ad is a hypothesis about that ad's destination/hook, not the traffic buying it.

## Related

- [[growth-director-analytical-brief]] — the Phase-1 scorecard this reads. Together they are the analytical / reasoning layer above the media-buyer tool.
- [[growth-director]] — the director this feeds. Phase 3 will wire the hypotheses into the director's Max session as the source of proposed experiments.
- [[../ads/winning-creative-detect]] — the media-buyer floor discipline this mirrors (`DEFAULT_MIN_SPEND_CENTS`).
- [[../specs/growth-director-analytical-brief]] — the spec.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
