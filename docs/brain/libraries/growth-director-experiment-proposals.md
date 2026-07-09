# libraries/growth-director-experiment-proposals

Phase 3 of [[../specs/growth-director-analytical-brief]] — the routing + Slack-delivery layer that turns each **high-confidence** [[growth-director-hypotheses|hypothesis]] into a PROPOSED experiment (draft, owner-gated, never serving) AND composes the analytical brief + hypotheses + proposals into a Slack digest for `#director-growth-max`. **North star** ([[../operational-rules]] § supervisable autonomy): Max PROPOSES and ROUTES; he never AUTO-SERVES spend.

**File:** `src/lib/agents/growth-director-experiment-proposals.ts` · Reads the Phase-1 `AnalyticalBriefResult` + the Phase-2 `HypothesesResult` shapes directly. Pure over the input; no DB fetches, no side effects.

## The three routing rails

| Hypothesis kind | Routes to | Payload |
|---|---|---|
| `funnel_not_creative` | `destination_experiment` (a [[storefront-experiments]] matched-lander / destination test) | `{ lander_type: 'advertorial', lever: 'matched_lander_destination', audience: 'all' }` |
| `format_effectiveness` | `destination_experiment` (matched-lander test on the winning format) | `{ lander_type: <top variant>, lever: 'matched_lander_format', audience: 'all' }` |
| `delivery_anomaly` | `creative_angle` (the creative maker / ideas bin — a fresh angle refresh) | `{ hook_thesis: … }` |
| `audience_signal` | `audience_test` (a new test ad set with a narrower interest thesis) | `{ audience_summary: … }` |

Every `ProposedExperiment` carries `status: 'draft'` + `owner_gated: true` — the acquisition-hub gating shape ([[acquisition-hub]]). A downstream router that reads `owner_gated !== true` OR `status !== 'draft'` MUST refuse (the runtime guard `assertProposalOwnerGatedDraft` is exported for exactly this compare-and-set check — [[../operational-rules]] § "guard before mutation" · learning #5-6).

## The Slack digest

`composeGrowthDirectorDigest(brief, hypotheses, proposals)` returns `{ channel, text, blocks, quiet }` — the shape any `postMessage` slack path consumes ([[slack]]). Contents:

- **Header** — `Growth Director brief — <window>`
- **Cohorts** — one-line rollup per live cohort ($ spend / # creatives)
- **Hypotheses** — one section block per hypothesis: title + confidence + summary + verbatim evidence line (`ctr=2.0 (vs 1.0), lpv_to_atc_rate=0 (vs 0.05)` …)
- **Proposed experiments** — one section block per proposal: title + `(kind · status=draft · owner-gated)` + source hypothesis + proposed test + rationale
- **Below-sample-gate context** — a footer count when creatives were filtered

The channel is a NAMED constant `GROWTH_DIRECTOR_SLACK_CHANNEL = '#director-growth-max'` — an audit of "where does the Growth Director talk to the founder" grep-resolves via that symbol, never a raw string.

**Quiet-week digest:** when NEITHER hypotheses nor proposals fire, the composer still returns a well-formed digest with `quiet: true` + text `"Growth Director brief — <window>: quiet week"` — the founder never notices a silent skip.

## The confidence-floor rail

Only `confidence: 'high'` hypotheses ROUTE — a `medium` hypothesis returns as `belowConfidenceFloor` so the digest can narrate the read without routing a test against a shaky signal. Symmetric to the media-buyer $50 verdict-floor discipline that gates the Phase-2 hypothesis emission itself.

## Exports

- **`proposeExperimentsFromHypotheses(hypotheses)`** → `{ proposals, belowConfidenceFloor }`. Pure — deterministic over the input.
- **`proposalFromHypothesis(h)`** → `ProposedExperiment | null`. The per-hypothesis mapping; useful for tests + hand-routing.
- **`composeGrowthDirectorDigest(brief, hypotheses, proposals)`** → `GrowthDirectorDigest`. The Slack composer.
- **`assertProposalOwnerGatedDraft(p)`** — throws if a proposal has drifted off `status='draft'` OR `owner_gated=true`. The WORKER calls this as its guard before the SDK insert.
- **Types** — `ProposedExperiment`, `ProposalKind`, `ProposalStatus`, `DestinationExperimentPayload`, `CreativeAnglePayload`, `AudienceTestPayload`, `GrowthDirectorDigest`, `DigestBlock`.
- **Constants** — `PROPOSAL_STATUS_DRAFT='draft'`, `PROPOSAL_CONFIDENCE_FLOOR='high'`, `GROWTH_DIRECTOR_SLACK_CHANNEL='#director-growth-max'`.

## Gotchas

- **`ProposedExperiment.status` is typed as the literal `'draft'`** — not the wider `ExperimentStatus` union — so a caller CAN'T pass `'running'` here. TypeScript is the first rail.
- **`owner_gated` is typed as the literal `true`** — same reason. `owner_gated: false` fails at compile time, not runtime.
- **The module NEVER inserts DB rows.** The WORKER does that after owner approval. That's how the spec's "grep confirms no auto-serve/auto-spend path" verification passes — no `.from('storefront_experiments').insert(…)` here.
- **`(unresolved)` variants + `unknown` cohorts** were filtered upstream at Phase 2 — no proposal ever names them.

## Related

- [[growth-director-analytical-brief]] — Phase 1 · the scorecard the Director reasons over.
- [[growth-director-hypotheses]] — Phase 2 · the pure hypothesis generator this reads.
- [[storefront-experiments]] — the destination_experiment target (owner-approved → running).
- [[acquisition-hub]] — the same draft/proposed → approve rail this mirrors.
- [[../specs/growth-director-analytical-brief]] — the spec.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
