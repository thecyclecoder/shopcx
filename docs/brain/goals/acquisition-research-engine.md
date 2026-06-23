# Acquisition Research Engine

**Outcome:** a standing, always-on **competitive research + gap-finding system** across our **two biggest new-customer-acquisition touchpoints — ad creatives and landing pages**. It runs continuously: it knows who we compete with per product, watches what they run, snapshots their pages, and surfaces the **gaps** (angles/sections/proof they have that we don't) as actionable recommendations — feeding our ad iteration engine and our [[storefront-optimizer|Storefront Optimizer]]. It's a team of **scouts**, housed together: a **Competitor Scout** (the foundation) that identifies competitors per product and feeds **research destinations** to an **Ad Creative Scout** and a **Landing Page Scout**. Its **boss is the [[../functions/growth|Growth director]]** (Head of Growth), which sets objective + guardrails and **grades the research**; Growth reports to the **[[ceo-mode|CEO]]**. North-star chain ([[../operational-rules]] § North star): CEO → role agent → tool.

**Success metric:** **gap → validated-improvement throughput** — the number of competitor-sourced gaps that become a shipped ad-creative iteration or a landing-page experiment per period, and the **win rate** of those. Plus **coverage** (every active product has an approved competitor set + fresh ad/lander snapshots) and the scouts' **average research grade** trending up. Owns/contributes to Growth's new-customer-acquisition north-star metric.

**Target:** decompose + sequence via the [[../specs/goal-decomposition-engine|goal decomposition engine]] (human-gated) into the milestone specs below. This doc is the seed + the design contract.

## The shape (one foundation feeding two scouts, housed together)
```
                       ┌─ Ad Creative Scout   (what winning ad ANGLES competitors run → gaps → ad iteration)
Competitor Scout  ─────┤
  (per product →       └─ Landing Page Scout  (snapshot their LANDERS + ours → gaps → enhancements/experiments)
   research targets)
            ↑ feeds research destinations to both ↓
                       Acquisition Research Hub  (one surface; recommendations route to Build / the optimizer)
```

## Why this ordering — the foundation is competitor identification
Today **`COMPETITOR_SEEDS` is a hardcoded list of 11 brands** in `adlibrary.ts` — which violates the project's "never hardcoded, always DB-driven" rule. Competitor identification is the crucial upstream input for **both** ad research and landing-page research, and it's the only place the **landing-page URLs** come from (AdLibrary returns ad creatives + advertiser, **not** destination URLs). So: identify competitors first (DB-driven, supervisable), then both scouts read that set — neither re-derives competitors.

## Foundations we already have (don't rebuild — fold in)
- ✅ **Ad creative finder** — `creative-finder-daily-cron` + [[../integrations/adlibrary|AdLibrary]] integration ([[../specs/winning-static-creative-finder]]): sweeps long-running competitor + category ads → vision-deconstructs to `creative_skeletons`. **Built but** (a) seeded from a **hardcoded** competitor list and (b) `creative_skeletons` is currently **empty** (sweep not yet collecting in prod). The Ad Creative Scout = this tool, migrated to the DB competitor set + a gap-finding layer.
- ✅ **Storefront Optimizer** ([[storefront-optimizer]]) — consumes landing-page gaps as **experiments** (the Landing Page Scout's downstream). Its "missing-tool → build-or-request" pattern is the model for turning a gap into a shipped component.
- ✅ **Headless browser + screenshots** — `scripts/spec-test-browser-check.ts` (mobile viewport + screenshots) — the substrate for snapshotting landers per chapter.
- ✅ **Chapter tracking / hero-gen / `creative_skeletons` / `creative-skeleton` vision deconstruction** — reuse, don't rebuild.

## Autonomy (the leash — supervisable)
- **Autonomous within policy:** running sweeps, taking snapshots, vision-analysis, *proposing* gaps + competitor additions — all read/propose, low-risk.
- **Approval-gated:** adding a competitor to a product's set (an alerting/spend contract), and any gap recommendation that becomes a Build or a live experiment (routes through the existing optimizer/Build approval). The scout **proposes with evidence**; the Growth director approves — the competitive set + the work queue are curated, not silently drifting.

## Decomposition
- **M1 — Competitor Scout (the foundation):** a per-product agent that identifies + ranks real competitors (LLM + web search for the direct set & their lander URLs · category-sweep heavy-advertiser promotion · product intelligence), writes a DB-driven `competitors` table (brand, domain, **PDP/lander URLs**, category mapping, ad-spend signal, status), **replaces the hardcoded `COMPETITOR_SEEDS`**, and is supervisable (proposes → owner approves). *(foundation — nothing precedes it.)*
- **M2 — Ad Creative Scout:** migrate the existing creative finder to read the `competitors` table (not hardcoded seeds), get the prod sweep actually collecting, and add a **gap-finding layer** (creative angles/formats competitors run that we don't → recommendations into the ad iteration engine). *(blocked by M1.)*
- **M3 — Landing Page Scout:** mobile, **per-chapter** snapshots of competitor landers (from M1's URLs) **and ours**, vision gap-analysis (sections/proof/structure they have that we lack), → PDP **enhancement recommendations** that route to Build (new components) or the [[storefront-optimizer|Optimizer]] (experiments). *(blocked by M1.)*
- **M4 — Acquisition Research Hub:** one dashboard surface housing the competitor sets + both scouts' findings + the gap queue, where the owner reviews/approves and recommendations route to Build / the optimizer. The "house it all together." *(blocked by M2, M3.)*
- **M5 — The continuous loop + grading:** the standing cadence (periodic re-scan, fresh-competitor promotion, new-gap surfacing) + the Growth-director **research grade** (was the gap real? did the resulting test win?) that trains the scouts. Makes it "constant research," not a one-shot. *(blocked by M4.)*

## Ownership & mirrors
Owner: [[../functions/growth]] (Head of Growth role). Parent: a Growth acquisition mandate, reporting to [[ceo-mode]]. Mirrors the [[storefront-optimizer]] goal's structure (foundation → agent → hub → grading loop) and the [[../specs/repair-agent|repair agent]] detect→propose→approve pattern.
