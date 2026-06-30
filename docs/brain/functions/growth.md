# Growth (function)

The permanent owner of **paid acquisition + landing-page conversion**. One of the org-chart functions ([[../goals/ceo-mode]]); this doc is both the **Growth director-agent's CEO-mode charter** and the **home that owns every Growth mandate + spec** on the roadmap. A function is never "done" — it carries perpetual mandates and contributes to finite goals.

> **Operate + author, never build (CEO directive 2026-06-29).** The Growth director OPERATES its own software (its `function_autonomy` is *operational* autonomy) and AUTHORS specs for the tools it needs — it is the requester/operator. It NEVER drives a build: **Ada / Platform / DevOps is the sole builder for every spec, all departments, permanently** ([[platform]]). A Growth-owned spec's `owner` is attribution + where the finished tool's operation lives; the build is always Ada's. Growth going live+autonomous does not move build-driving onto it. The Growth director's **supervision machinery** lives in [[../libraries/growth-director]] — the agent that investigates + auto-approves Growth-routed approval requests within a leash, mirroring the Platform director pattern.

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
  - [[../specs/growth-adopt-creative-makers]] ✅ — Director-visible ready-to-test queue for creatives + Director-approved publish with PAUSED ads + outcome lineage (archived → [[../lifecycles/ad-publish]]).
  - _(future: auto-pause underperformers; variant generator; creative-performance scoring)_

### Ad-matched landing pages
Every ad has a scent-matched lander (advertorial / before-after) so paid traffic converts.
- **Metric:** lander conversion rate by campaign; ad→lander scent-match coverage.
- **Specs:** **advertorial-landers** ✅ (verified + archived → [[../lifecycles/advertorial-landers]])

### Storefront CRO
The storefront is a conversion surface — continuously lift PDP engagement and price-step conversion across the Amazing Coffee funnel.
- **Metric:** PDP engagement, price-step conversion, sessions→subscription rate; ultimately **predicted-LTV-per-visitor**.
- **Goal:** [[../goals/storefront-optimizer]] — the autonomous **Storefront Optimizer agent**, this director's *graded employee*: form hypothesis → run a bandit campaign → learn (a hierarchical lever-importance model) → promote/kill, across all four Amazing Coffee lander types, optimizing predicted-LTV-per-visitor. **This is the "landing-page experiment harness" gap (above), finally built** — and a concrete CEO→role-agent→tool instance for [[../goals/ceo-mode]]. The Growth director sets its rails + grades each campaign 1–10.
- **Specs:** **storefront-mvp** ✅ (verified + archived → [[../lifecycles/storefront-checkout]]) · **homepage-rebuild** ✅ (verified + archived → [[../recipes/edit-shopify-theme]]) · **checkout-customize-bypass** ✅ (verified + archived → [[../lifecycles/storefront-checkout]]) · **storefront-survey-chapter** ✅ (verified + archived → [[../lifecycles/storefront-checkout]]) · [[../specs/storefront-iteration-engine]] ⏳ (the ad-side iteration engine — the optimizer's funnel partner) · [[../specs/growth-adopt-meta-iteration-engine]] ✅ (Director authoring/activation surface — the engine's governance, so it can leave dormant mode and start making autonomous decisions under Director supervision) · **growth-adopt-storefront-optimizer** ✅ (Director-authored scope + thresholds, brief surfaces proposals + grades, delivery-verification gate — verified + archived → [[../lifecycles/storefront-checkout]]).

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

## Autonomy (cutover + rollback)

The Growth director's `function_autonomy('growth')` flag is the one switch that flips Growth from CEO-routed approvals to Growth-director auto-approval (mirrors [[platform]]'s 2026-06-23 20:35 cutover via `scripts/apply-platform-live-autonomous.ts`). The activation pipeline is the [[../specs/growth-director-live-autonomous-cutover]] spec — pre-flight gate (`scripts/check-growth-cutover-ready.ts`), then the flip (`scripts/apply-growth-live-autonomous.ts` or the Agents-hub toggle `POST /api/developer/agents/autonomy {function_slug:'growth', live:true, autonomous:true}`), then the post-flip surfaces verification. Activation timestamp lands here when the flip happens (Phase 3 of the spec).

**Rollback** — turning Growth back to CEO-routed is the same toggle in reverse, from the same Agents-hub surface: `POST /api/developer/agents/autonomy {function_slug:'growth', autonomous:false}`. The route's `if (!live) autonomous = false` invariant means clearing `live` also clears `autonomous`. Once `autonomous=false`, [[../libraries/approval-router]] `resolveApprover` walks past Growth and routes growth-owned approvals up to the CEO again; the dormant guards on the box-worker `growth-director` job, the daily Growth recap, and the grade rollup re-engage on the next poll. Idempotent + reversible: no DB cleanup, no replay — flip on, flip off.

## Status

Charter doc — planned. Specs under it appear on the roadmap board grouped under Growth. First spec: [[../specs/winning-static-creative-finder]].
