# CEO Mode

**Outcome:** ShopCX runs in "CEO mode" — a standing executive team of specialist agents (CFO, Growth, CMO, Retention, Logistics, Customer Service) each watching their domain, reporting to a **CEO agent** that prioritizes under constraints and directs traffic. It continuously ingests the company's financial, inventory, ads, website, Amazon, and supplier data, reasons about the gap to our growth targets, and either **executes** low-risk moves or **recommends** the high-stakes ones — growing the **top line** (revenue) and **bottom line** (profit), with every action measured after it ships.

**Success metric:** a weekly CEO brief that (a) reports top- and bottom-line vs. target from a single trusted source, (b) issues ranked, quantified moves ("raise SKU X price 8% → +$Y margin/mo; reorder SKU Z by date D"), and (c) shows whether *last* week's moves actually shifted the metric. North star: **enterprise value** (we are building toward a sellable company) = EBITDA × multiple + a defensible moat + clean books, with a non-negotiable monthly-profitability floor.

**Target:** decompose + sequence via the [[../specs/goal-decomposition-engine|goal decomposition engine]] (human-gated). This doc is the seed; the planner fills in the tree.

## The org model

**Directors are scheduled specialist analysts, not always-on bots.** Each runs a weekly pass (plus on-demand deep-dives the CEO can task), reads its domain, and returns one **standard report contract** so the CEO can compose them:

```
{ domain, health_score, metrics_vs_target[],
  findings[],
  recommended_actions[{ action, expected_impact_$, effort, confidence, reversible?, depends_on }],
  risks[] }
```

| Director | Owns | Data we have | Gap |
|---|---|---|---|
| **CFO** | P&L, margin, cash, LTV:CAC, unit economics | orders, Braintree, Avalara | COGS/supplier, metrics spine |
| **Growth** | paid ads + landing-page CRO, CAC, ROAS | Meta + Google Ads, storefront analytics | LP experiment harness |
| **CMO** | email/SMS/organic/blog/site content | Klaviyo, Twilio, social, [[../specs/auto-blog-generation\|auto-blog]] | content→revenue attribution |
| **Retention** | subscriptions, dunning, cancel-flow, win-back — keeping people subscribed | [[../tables/subscriptions]], [[../lifecycles/cancel-flow]], [[../lifecycles/dunning]] | churn modeling |
| **Logistics** | inventory, 3PL, suppliers, stockouts | `product_variants` ([[../inngest/sync-inventory]]), Amplifier | supplier lead times, Amazon |
| **CS Manager** | ticket volume, CSAT, churn, refund/return rate, the AI's own performance | tickets, analyses, CSAT | — (rich already) |

Plus a non-business seat: **[[../functions/platform|Platform / Engineering]]** (the CTO-equivalent) owns the build system that ships every capability-gap spec the directors surface — see the two-lanes loop below.

**The CEO is a prioritizer, not an aggregator.** Any director can find ten opportunities; the CEO decides **the few that matter this month**, arbitrates conflicts (CFO "cut spend" vs Growth "scale, CAC is under target") against the standing priorities, and says explicitly what we are *not* doing and why.

**The CEO constitution** (versioned doc = the CEO's system prompt): standing priorities (profitability floor; build toward sale → enterprise value), decision principles (radical prioritization, opportunity cost, expected-value ranking, reversible-vs-irreversible, second-order effects — Dalio / Munger / first-principles), and hard constraints. Dylan edits it as his thinking evolves.

## Two output lanes (this is the loop that closes)

Every greenlit action is one of:
- **Operational** — "raise SKU X price," "pause campaign Y," "reorder Z." Executed or recommended (see authority below).
- **Capability gap** — "we should run win-back SMS, but we have no win-back flow." Not an action — a **spec**, routed straight into the [[../specs/goal-decomposition-engine|goal decomposition engine]] → box worker → PR.

So CEO mode **runs the company AND emits the specs to build the tools it needs to run the company better.** Directors surface gaps → CEO prioritizes → engine ships them → next week's pass sees the new capability.

## Execution authority (owner, 2026-06-18)

**Recommend + auto-execute low-risk.**
- **Auto-execute** (via the [[../specs/build-approval-gates|approval-gate]] worker): reversible, bounded actions — reorder within a preset budget, pause a campaign over its CAC ceiling.
- **Always gate** (one-tap approval): price changes, *new/increased* spend, any customer-facing send (email/SMS/social), and every capability-gap **spec→build**.
- Earn trust on recommendation quality first; expand the auto-execute envelope over time.

## Decomposition

_Planner fills/refines this (Plan → propose tree → approve branches). Current target shape:_

- **M0 — CEO constitution + report contract.** The decision doc + the director output schema. Cheap, foundational, first. ⏳
- **M1 — Metrics spine + COGS.** Unified store the analysts read instead of 8 live APIs; COGS/landed-cost so margin is computable (CFO + Logistics depend on it). ⏳
- **M2 — Growth Director (first director prototype).** Ads + landing-page CRO over Meta + Google (data we have) → ROAS/CAC moves, measurable week-over-week. Proves the director→CEO contract. ⏳
- **M3 — Remaining directors** — CFO, CMO, Retention, Logistics, CS Manager (one spec each). ⏳
- **M4 — CEO synthesizer.** Reads director reports + constitution → ranked brief + the two lanes + auto-exec/gate routing. ⏳
- **M5 — Weekly brief delivery + measurement loop.** Attribute shipped moves to metric movement. ⏳
- **M6 — Close remaining data gaps** surfaced along the way (Amazon integration, supplier lead times). ⏳

## Current state — what the brain says we already have

Grounding so the planner starts from truth (it should verify + extend):

- **Revenue / financial:** Shopify orders ([[../tables/orders]]), Braintree ([[../integrations/braintree-customer]]), Avalara tax. Order-level revenue yes; unified P&L / margin no.
- **Inventory:** `product_variants.inventory_quantity` + `available`, synced hourly ([[../inngest/sync-inventory]]), readable via `check_inventory` ([[../orchestrator-tools]]).
- **Ads:** Meta Graph + Google Ads (spend, campaigns).
- **Website:** Google Search Console; some storefront analytics ([[../lifecycles/storefront-checkout]]).
- **Amazon:** no integration — gap.
- **Supplier / COGS / landed cost:** no page — gap (required for bottom-line reasoning).
- **Unifying spine:** none — gap.

## Status

Planned — awaiting first plan pass. Rollup computes from linked specs once the [[../specs/goal-decomposition-engine|engine]] ships and the tree is approved. First director to build: **Growth**.
