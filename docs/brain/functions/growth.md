# Growth (function)

The permanent owner of **paid acquisition + landing-page conversion**. One of the org-chart functions ([[../goals/ceo-mode]]); this doc is both the **Growth director-agent's CEO-mode charter** and the **home that owns every Growth mandate + spec** on the roadmap. A function is never "done" — it carries perpetual mandates and contributes to finite goals.

## Scope + owned metrics

- **Owns:** paid ads (Meta + Google), landing-page CRO, the creative pipeline, funnel conversion.
- **North-star metrics:** blended **CAC**, **ROAS**, new-customer revenue, landing-page conversion rate. Bottom-line guardrail: contribution margin after ad spend (needs the CFO's COGS — see [[../goals/ceo-mode]] M1).
- **Data we have:** Meta Graph + Google Ads (spend, campaigns, creative), storefront analytics ([[../lifecycles/storefront-checkout]]).
- **Gaps:** a landing-page experiment harness; a creative-performance store (which ads actually win).

## Mandates (perpetual)

### Static-ad optimization
Continuously find, test, and scale **winning static creative**, and kill losers — so we always have a pipeline of killer static ads. Never "done"; measured by a **metric trend**, not % complete.

- **Metric:** winning-creative hit-rate + blended static-ad ROAS, week over week.
- **Loop:** source proven static concepts → drop into the **ideas bin** → produce variants → test → scale winners / cut losers → feed learnings back.
- **Specs under this mandate:**
  - [[../specs/winning-static-creative-finder]] ⏳ — ingest winning static ads (competitor/library/our own top performers) into the ideas bin so we can make more killer statics.
  - [[../specs/killer-statics]] ✅ — cold-50+ static archetypes, both formats.
  - _(future: auto-pause underperformers; variant generator; creative-performance scoring)_

### Ad-matched landing pages
Every ad has a scent-matched lander (advertorial / before-after) so paid traffic converts.
- **Metric:** lander conversion rate by campaign; ad→lander scent-match coverage.
- **Specs:** **advertorial-landers** ✅ (verified + archived → [[../lifecycles/advertorial-landers]])

### Storefront CRO
The storefront is a conversion surface — continuously lift PDP engagement and price-step conversion across the Amazing Coffee funnel.
- **Metric:** PDP engagement, price-step conversion, sessions→subscription rate.
- **Specs:** **storefront-mvp** ✅ (verified + archived → [[../lifecycles/storefront-checkout]]) · **homepage-rebuild** ✅ (verified + archived → [[../recipes/edit-shopify-theme]]) · **checkout-customize-bypass** ✅ (verified + archived → [[../lifecycles/storefront-checkout]]) · **storefront-survey-chapter** ✅ (verified + archived → [[../lifecycles/storefront-checkout]]) · [[../specs/storefront-iteration-engine]] ⏳ (the perpetual-CRO engine itself).

## The Growth agent supervises its tools (worked example)

The Growth specs are **tools**; the Growth role agent **owns the objective** and supervises them (see [[../goals/ceo-mode]] § "Role agents own the objective"). Concretely:

The [[../specs/storefront-iteration-engine]] is a controller with a setpoint — "scale winners, pause/down-scale losers to keep ROAS above target." When **no creative is winning**, its rules drive ad budget toward **~0**: locally correct (don't burn money on bad ROAS), globally catastrophic (revenue stops, our objective is destroyed). That budget→0 is **not an acceptable outcome — it's an alarm.**

The Growth agent, holding the real objective (profitable growth at CAC ≤ target, spend ≥ a revenue floor), catches it and:
1. **Guardrails the tool** — hold a budget floor / don't fully pause a proven product while we fix the root cause (operational, gated/auto-exec).
2. **Diagnoses root cause** — *why* is nothing winning? creative fatigue, targeting, landers, or offer.
3. **Spawns the upstream fix** — "we have no winning ads, improve CPA" becomes work: better creative ([[../specs/winning-static-creative-finder]]), a landing-page experiment harness, a targeting test — new specs under Growth's mandates.

So the tool's degenerate state is the **trigger** for the agent's highest-value work. This is why tools here must surface their reasoning + rails (the iteration engine emits *why* it's down-scaling) and respect agent-set guardrails — a silent optimizer is invisible to its supervisor.

## Owned / contributed goals

- Contributes to [[../goals/ceo-mode]] › **M2 — Growth Director** (first director prototype: ROAS/CAC analyst → CEO).

## Status

Charter doc — planned. Specs under it appear on the roadmap board grouped under Growth. First spec: [[../specs/winning-static-creative-finder]].
