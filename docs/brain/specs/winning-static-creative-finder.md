# Winning Static-Creative Finder ⏳

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate "Static-ad optimization"

A tool that continuously sources **proven winning static ad creative** — from ad libraries (Meta Ad Library), competitor sweeps, and our own top-performing statics — and drops the best candidates into our **ideas bin**, so the team always has a pipeline of references to turn into more killer static ads. The first concrete spec under Growth's perpetual static-ad-optimization mandate; it feeds the funnel that later specs (variant generation, scaling, auto-pause) build on.

## Phase 1 — Ideas bin + ingestion model
- ⏳ planned
- Define where ideas live (a `creative_ideas` store / table) and the card shape: source, image/asset, why-it-won signal (longevity, engagement, spend proxy), tags, status (new / shortlisted / in-production / shipped).
- Probe what we already capture from our own ads (Meta Graph creative + performance) before adding external sources.

## Phase 2 — Sources
- ⏳ planned
- Our own top performers (Meta insights → rank our static ads by ROAS/longevity → auto-add winners).
- External discovery (Meta Ad Library / competitor pages) — ingest long-running statics (longevity = a strong winner proxy) into the bin as references.

## Phase 3 — Surface + workflow
- ⏳ planned
- A dashboard "Ideas bin" view to browse/shortlist/promote candidates into production.
- Hook for the next mandate specs (variant generation) to pull from shortlisted ideas.

## Safety / invariants
- **External creative is reference/inspiration, not lifted assets** — store the concept + a link/screenshot for analysis; never republish a competitor's asset.
- Respects the no-orphan rule: owner = Growth, parent = the static-ad-optimization mandate.

## Completion criteria
- Winning statics (ours + external references) land in the ideas bin automatically, ranked by a why-it-won signal, browsable + promotable from the dashboard.
