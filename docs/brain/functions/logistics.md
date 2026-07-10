# Logistics (function)

The permanent owner of **inventory, replenishment, and fulfillment** — keeping the shelf stocked ahead of demand and every order moving out the door. One of the org-chart functions ([[../goals/ceo-mode]]); this doc is both the **Logistics director-agent's CEO-mode charter** and the **home that owns every Logistics mandate + spec**.

> **Why this seat exists.** A retention business dies two ways nobody upstream owns: a **stockout** (demand the brand created, no product to fulfill it — churn manufactured on purpose) and **fulfillment drag** (slow or costly shipping that erodes both margin and the customer experience). Growth makes the demand, Retention keeps the subscription, CS handles the fallout — but nobody owned making sure the *physical goods* are there and moving. This is that seat.

> **Operate + author, never build (CEO directive 2026-06-29).** The Logistics director OPERATES its own software (its `function_autonomy` is *operational* autonomy) and AUTHORS specs for the tools it needs. It NEVER drives a build: **Ada / Platform / DevOps is the sole builder for every spec, all departments, permanently** ([[platform]]). A Logistics-owned spec's `owner` is attribution + where the finished tool's operation lives; the build is always Ada's.

## Scope + owned metrics

- **Owns:** inventory levels + valuation, replenishment / reorder timing, supplier lead-time, fulfillment throughput, shipping cost + speed, and the stockout-risk signal that feeds the CEO north star.
- **North-star metrics:** in-stock rate (no lost sales to stockouts), days-of-cover vs. lead-time, fulfillment cost per order, ship-to-delivery time, inventory turns.
- **Data we have:** [[../tables/orders]] (demand signal), [[../tables/subscriptions]] (forecastable recurring demand — the retention model makes future demand *knowable*), shipping + returns ([[../integrations/easypost]] / [[../lifecycles/return-pipeline]]), Shopify inventory ([[../integrations/shopify]]).

## Mandates (perpetual)

### Inventory & replenishment
Keep every SKU stocked ahead of demand — forecast from the subscription base + order velocity, watch days-of-cover against supplier lead-time, and surface a reorder before a stockout can manufacture churn. The subscription model is the edge here: recurring demand is *forecastable*, so a stockout should never be a surprise.
- **Metric:** in-stock rate; zero demand-created churn from a preventable stockout.
- **Status:** ⏳ **seat opened, tooling not yet built.** First spec: stand up the inventory/replenishment signal (days-of-cover + reorder alerting) from live order + subscription velocity. Owner: logistics · Builder: Ada.

### Fulfillment & shipping ops
Own the path from paid order to delivered box — throughput, shipping cost, and delivery speed — and keep fulfillment cost from quietly eating margin (the number the [[cfo]] reconciles against).
- **Metric:** fulfillment cost per order, ship-to-delivery time; no silent shipping-cost drift.
- **Status:** ⏳ planned — follows the inventory signal.

## Owned / contributed goals

- Contributes to [[../goals/ceo-mode]] — the Logistics director seat.
- Feeds the CEO's **Company North Star** scoreboard with in-stock rate + stockout risk (a demand-fulfillment constraint the CEO must see), and the [[cfo]] with fulfillment cost + inventory valuation.

## Status

Charter doc. Seat opened 2026-07-10 (CEO directive: seat the missing business directors so the north star can be measured end-to-end). Owns inventory / replenishment / fulfillment — the physical-goods layer under the retention business. Director persona: 📦 **Marco**. Tooling is the first specs.

---

[[../README]] · [[ceo]] · [[cfo]] · [[growth]] · [[cmo]] · [[retention]] · [[cs]] · [[platform]] · [[../goals/ceo-mode]] · [[../operational-rules]] · [[../project-management]]
