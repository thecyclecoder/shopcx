# Growth Director — AcqROAS Report Contract Output ⏳

**Priority:** critical

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/ceo-mode]] › M2 — Growth Director

**Deferred:** split from [[growth-acquisition-roas-spine]] — not needed now: the per-product AcqROAS measurement *spine* (the parent's promise) is shipped + verified ([[../libraries/acquisition-roas]] `computeAcqROAS`, [[../libraries/shopify-internal-revenue]], [[../tables/product_ad_account_mappings]]). This report-contract wrapper has no consumer yet — the CEO synthesizer that reads director report contracts ([[../goals/ceo-mode]] M4) and the report-contract schema itself ([[../goals/ceo-mode]] M0) are both still planned, and the contribution-margin form is a declared dependency on M1 COGS. Build it alongside the Growth director-agent / CEO synthesizer so it targets the *final* schema with a real reader.

This is the **output/presentation layer** over the shipped metric: wrap `computeAcqROAS(product, window)` into the CEO-mode director **report contract** so the CEO synthesizer can compose it alongside the other directors. The agent **owns the objective** (profitable new-customer acquisition); AcqROAS is its **proxy** — see [[../goals/ceo-mode]] § 'Role agents own the objective'.

## Phase 1 — Growth report contract output ⏳
- Emit the CEO-mode director **report contract** ([[../goals/ceo-mode]]) per product line: AcqROAS, non-renewal new-customer revenue, channel mix, week-over-week delta, guardrail flag ('on-site ROAS<1 but halo-blended ≥ target — do NOT cut'). Contribution-margin ROAS is a **declared dependency on M1 COGS** — revenue-ROAS until then.
- **North-star guard:** name AcqROAS as a proxy; flag degenerate moves (cutting a proven SKU on on-site ROAS alone when the Amazon halo carries it).
- Consumes the shipped spine: [[../libraries/acquisition-roas]] `computeAcqROAS` — returns `acqRoas`, `channelSplit`, `haloRatio`, `assumptions`, `flags`; do not re-derive the metric.

## Verification
- [ ] Report contract validates against the CEO-mode director schema ([[../goals/ceo-mode]] § 'The org model'); assumptions + guardrail flags present.
- [ ] Every new library/config has a `docs/brain/` page in the same PR.
