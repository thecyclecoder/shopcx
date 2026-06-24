# Growth Director — AcqROAS Report Contract Output

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/ceo-mode]] › M2 — Growth Director

This is the **output/presentation layer** over the shipped metric: wrap `computeAcqROAS(product, window)` into the CEO-mode director **report contract** so the CEO synthesizer can compose it alongside the other directors. The agent **owns the objective** (profitable new-customer acquisition); AcqROAS is its **proxy** — see [[../goals/ceo-mode]] § 'Role agents own the objective'.

## Phase 1 — Growth report contract output
**Shipped 2026-06-24.** [[../libraries/growth-report-contract]] `buildGrowthReportContract` wraps
`computeAcqROAS` per product line into the standard director [[../libraries/director-report-contract]]
(the M0 schema-as-code: type + `validateDirectorReportContract`). Per-line metric row (AcqROAS, channel
mix, week-over-week delta), `assumptions` (revenue-ROAS; contribution-margin pending M1 COGS), and the
North-star do-NOT-cut guardrail (on-site ROAS<1 but halo-blended ≥ target → high-severity risk, never an
action). Reader is the M4 CEO synthesizer (still planned) — fold this spec into [[../libraries/acquisition-roas]]
+ lifecycle once M4 reads it.
- Emit the CEO-mode director **report contract** ([[../goals/ceo-mode]]) per product line: AcqROAS, non-renewal new-customer revenue, channel mix, week-over-week delta, guardrail flag ('on-site ROAS<1 but halo-blended ≥ target — do NOT cut'). Contribution-margin ROAS is a **declared dependency on M1 COGS** — revenue-ROAS until then.
- **North-star guard:** name AcqROAS as a proxy; flag degenerate moves (cutting a proven SKU on on-site ROAS alone when the Amazon halo carries it).
- Consumes the shipped spine: [[../libraries/acquisition-roas]] `computeAcqROAS` — returns `acqRoas`, `channelSplit`, `haloRatio`, `assumptions`, `flags`; do not re-derive the metric.

## Verification
- [x] Report contract validates against the CEO-mode director schema ([[../goals/ceo-mode]] § 'The org model'); assumptions + guardrail flags present. — `buildGrowthReportContract` output passes `validateDirectorReportContract` ([[../libraries/director-report-contract]]); `assumptions[]` (revenue-ROAS + COGS dependency + shared-account floor) and the do-NOT-cut `risks[]` guardrail are populated; `proxy`/`objective` name AcqROAS as the proxy.
- [x] Every new library/config has a `docs/brain/` page in the same PR. — [[../libraries/director-report-contract]] + [[../libraries/growth-report-contract]].
