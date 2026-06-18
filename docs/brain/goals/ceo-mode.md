# CEO Mode

**Outcome:** ShopCX can run in "CEO mode" — continuously ingest the company's financial, inventory, ads, website, Amazon, and supplier data, reason about the gap to our growth targets, and proactively recommend the specific moves that grow the **top line** (revenue) and **bottom line** (profit), with each recommendation measured after it ships.

**Success metric:** a weekly CEO brief that (a) reports top- and bottom-line vs. target from a single trusted source, and (b) proposes ranked, quantified actions ("raise SKU X price 8% → +$Y margin/mo at current volume; reorder SKU Z by date D to avoid stockout") — and a measured feedback loop showing whether shipped recommendations moved the metric.

**Target:** decompose + sequence via the [[../specs/goal-decomposition-engine|goal decomposition engine]] (human-gated). This doc is the seed; the planner fills in the tree.

## Current state — what the brain says we already have

Pulled from the brain so the planner starts grounded (it should verify + extend):

- **Revenue / orders / financial:** Shopify orders ([[../tables/orders]]), Braintree payments ([[../integrations/braintree-customer]]), Avalara tax. We have order-level revenue; we do **not** yet have a unified P&L or margin view.
- **Inventory:** `product_variants.inventory_quantity` + `available`, synced hourly ([[../inngest/sync-inventory]]) — now readable by the orchestrator via `check_inventory` ([[../orchestrator-tools]]).
- **Ads:** Meta Graph + Google Ads integrations exist (spend, campaigns).
- **Website performance:** Google Search Console; some storefront analytics ([[../lifecycles/storefront-checkout]]).
- **Amazon:** no integration in the brain — **likely a gap**.
- **Supplier / COGS / landed cost:** no page in the brain — **likely a gap**. Required for any *bottom-line* reasoning (can't optimize profit without margins).
- **Unifying spine:** none — data lives in 8 separate APIs/tables. A single metrics store the analyst reads is **likely a gap**.

## Decomposition

_To be filled by the planner (Plan → propose tree → approve branches). Expected first-pass milestones:_

- **M1 — Data spine:** a unified metrics store the analyst reads instead of live-querying 8 sources. ⏳ (spec TBD)
- **M2 — Close the data gaps:** Amazon integration; COGS/supplier + landed-cost so margin is computable. ⏳ (specs TBD)
- **M3 — Analyst loop:** the strategic engine — read the spine, compute gap-to-target, rank quantified recommendations. ⏳ (spec TBD)
- **M4 — Measurement loop:** attribute shipped recommendations to metric movement (close the loop, make it strategic not just a dashboard). ⏳ (spec TBD)
- **M5 — Weekly CEO brief:** the delivery surface. ⏳ (spec TBD)

## Status

Planned — awaiting first plan pass. Rollup will compute from linked specs once the [[../specs/goal-decomposition-engine|engine]] ships and the tree is approved.
