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

### Crisis-aware replenishment & allocation (the Marco doctrine)
The replenishment signal is not just "days-of-cover vs lead-time" — it is **inventory allocation in service of the highest-margin revenue**. The doctrine, battle-tested against live QuickBooks + channel data 2026-07-10:

- **⭐ North star — subscription renewal revenue is the most valuable revenue we have.** A renewal carries **no acquisition cost** (only the *original* order paid the CAC); the renewal is nearly pure margin. So the supreme rule: **never create friction for a renewal, and never let a preventable stockout choke the recurring base.** Preserve inventory for **true (non-crisis) subscribers at all costs** — they are the compounding asset.
- **Availability is a demand lever, not just a status.** When a variant is scarce, the Director can **remove that variant as a checkout option on the Shopify storefront + the customer portal (swap flows)** to *slow its burn rate* and protect remaining units for subscribers — and **return it** (plus siblings like Peach Mango) once restocked. Turning options on/off shapes demand; the Director owns that lever.
- **Crisis-aware (integrates [[../lifecycles/cancel-flow]] / [[../tables/crisis... ]] demand).** A stockout drives **crisis-enrolled** customers onto a substitute flavor; when the original restocks they **flip back**, so burn **flip-flops** between variants. The Director must forecast this transfer, not just extrapolate the current rate. *Live example (2026-07): Mixed Berry 30ct is storefront-OOS (3PL=0); crisis customers were routed to Strawberry Lemonade, spiking SL burn to ~884/mo (~1.4mo cover vs a ~4.6mo lead time). Inbound PO #116193 (10K units, ETA ~Jul 29) restocks Berry → recommended play: as soon as Berry is back, pull SL from storefront + portal swap options, return Berry + Peach Mango, and reserve remaining SL for true SL subscribers. Then forecast the post-swap burn (≈900 subs flipping back to Berry + Berry returning to storefront) and — because that projected Berry burn will again approach the lead time — proactively cut the NEXT Berry PO.*
- **Lead time is measured, not guessed.** Per finished good: match each **PurchaseOrder → its receiving Bill** via QuickBooks' native `LinkedTxn` link; lead = Bill.TxnDate − PO.TxnDate. Track **fill rate** (received ÷ ordered) separately — manufacturers under-produce ~5% (VitaQuest SL: ordered 8,334 → received 7,931). **Expected-arrival dates live in OUR system** (QB `PurchaseOrder.DueDate` is blank), so the Director annotates open POs with an ETA.
- **Burn rate must be a recent trailing, per-channel-normalized rate with Amazon case-pack multipliers.** Sales ramp, so a long average lies (a 6-mo avg understated ramping SL burn by ~3×). Combine Shopify + internal + Amazon; Amazon 1-pack vs 2-pack ASINs both map to the same finished good via `unit_multiplier` (a 2-pack sale burns 2 units). Report cover two ways: **sellable-now** vs **pipeline** (incl. cases staged at the 3PL bound for FBA). Engine: [`src/lib/logistics/cover.ts`](../../../src/lib/logistics/cover.ts) `computeCover`. **Two load-bearing gotchas** (both caused a ~2× SL undercount before fixing):
  - **Match order line-items by numeric Shopify `variant_id`, not `sku`.** Subscription orders (`subscription_contract*`, the bulk of volume) carry the line with `variant_id` set but `product_id`/`sku` NULL or varying. Fall back to `seller_sku` only for the internal-storefront path (those lines carry a ShopCX UUID `variant_id` + a stable sku). Every matched line counts toward burn — only *internal* is split out — so `subscription_contract` + `shopify_draft_order` are not dropped.
  - **PostgREST caps `.select()` at 1000 rows — paginate the `orders` read** (`.range()` loop). An un-ranged query silently truncated a month to its first 1000 orders. Reconciles **exact** vs Shopify/Shoptics: SL June 2026 = **1049** Shopify units, trailing-3mo = **1211/mo** Shopify; on-hand hand-verified 647 sellable / 1175 pipeline.
- **The unit that gets replenished is the `-F` finished good** (e.g. `SC-TABS-SL-F`), not the virtual sellable bundle/Group; sales resolve to the bundle then roll to the `-F` via BOM ×1.
- **Owns the Crisis tool (cross-department, Logistics ↔ [[cs]]).** The [[../lifecycles/crisis-comms|Crisis]] flow ([`/dashboard/crisis`](../../src/app/dashboard/crisis)) is **owned by Logistics** — a stockout-driven flavor substitution (e.g. Berry-OOS → route to SL) is fundamentally a Logistics **inventory-allocation** decision; **CS executes** the customer-facing side (comms, enrollment, the swap conversation). This is **one of our first true cross-department tools**: Logistics sets the allocation policy (which variant to protect, which substitute to offer, when to swap back), CS runs it against customers. Cross-listed under both the Logistics and Customers nav areas.
- **Provenance / build model (this tooling only):** the Logistics inventory/replenishment tools are being built **directly by Claude with the founder** (not via the spec→Ada pipeline), because they are tightly coupled to the Shoptics→ShopCX accounting migration ([[../lifecycles/shoptics-migration]]) and require continuous Shoptics-code reference. Kept off `public.specs` by founder directive (2026-07-10) — no devops operation. This is a deliberate, bounded exception to "Ada is the sole builder"; general doctrine unchanged.
- **Status:** 🚧 Milestones 1 + 1.5 shipped — the **Logistics** dashboard area (sidebar + Replenishment/Inventory/Mappings/Lead-Times/Suppliers) on the migrated `qb_*` tables + live QuickBooks, canonical inventory model ([[../tables/inventory_levels]] via daily FBA + 3PL + hourly Shopify sync), measured lead times (PO→Bill LinkedTxn), and **days-of-cover** (burn vs on-hand vs lead time, reconciled exact) live on the Replenishment page. **Next:** M2 suppliers + PO ETA annotation tables; M3 crisis-aware allocation + demand flip-flop forecast; deprecate the `product_variants.inventory_quantity` scalar in favor of `inventory_levels`.

## Owned / contributed goals

- Contributes to [[../goals/ceo-mode]] — the Logistics director seat.
- Feeds the CEO's **Company North Star** scoreboard with in-stock rate + stockout risk (a demand-fulfillment constraint the CEO must see), and the [[cfo]] with fulfillment cost + inventory valuation.

## Status

Charter doc. Seat opened 2026-07-10 (CEO directive: seat the missing business directors so the north star can be measured end-to-end). Owns inventory / replenishment / fulfillment — the physical-goods layer under the retention business. Director persona: 📦 **Marco**. Tooling is the first specs.

---

[[../README]] · [[ceo]] · [[cfo]] · [[growth]] · [[cmo]] · [[retention]] · [[cs]] · [[platform]] · [[../goals/ceo-mode]] · [[../operational-rules]] · [[../project-management]]
