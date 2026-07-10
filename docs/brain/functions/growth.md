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
  - [[../specs/media-buyer-test-winner-loop]] ⏳ — Media Buyer worker agent + weekly Test→Measure→Promote→Kill cadence: a controlled autonomous go-live into a capped test ad set (Phase 1 gate — [[../libraries/media-buyer-publish-gate]] + [[../tables/media_buyer_test_cohorts]]), a `media-buyer` lane in [[../libraries/builder-worker]] (Phase 2 — [[../libraries/media-buyer-agent]]) that promotes winners / kills losers / replenishes the test cohort under one conservative [[../tables/iteration_policies]] version, and Phase 3 fatigue-triggered replenish (`amplifyWinner` when a WINNER's fatigue_score ≥ 0.5) + grading (deterministic [[../libraries/media-buyer-grader]] scoring each action against realized ROAS in [[../tables/meta_attribution_daily]] resolved 3d+ later, writing to [[../tables/media_buyer_action_grades]]). Owned by this function; the Growth Director supervises within its leash.
  - _(future: variant generator; creative-performance scoring)_

### Ad-matched landing pages
Every ad has a scent-matched lander (advertorial / before-after) so paid traffic converts.
- **Metric:** lander conversion rate by campaign; ad→lander scent-match coverage.
- **Specs:** **advertorial-landers** ✅ (verified + archived → [[../lifecycles/advertorial-landers]])

### Acquisition research (Rhea, beside Cleo)
**Rhea** is Growth's research worker — the URL sensor + teardown classifier operating alongside Cleo (the [[../libraries/storefront-optimizer-agent|Storefront Optimizer]]). She writes [[../tables/research_urls]] (and only that table): the deterministic sync surfaces every distinct ad-scout destination as `teardown_verdict='unreviewed'`, and Rhea's box lane ([[../libraries/research-urls]] SDK + [[../recipes/lander-capture]]) captures each URL and stamps `classification` + `teardown_verdict` + `rationale`. Read by Cleo's Storefront Optimizer and by the Content Agent handoff to draft the next lander. North star: she proposes and classifies; she never acts.

- **Metric:** worthy-lander hit-rate (share of captured URLs Rhea marked `worthy`); unviewable rate (bot-block coverage).
- **Loop:** ad scout captures a destination → sync upserts a `research_urls` row `unreviewed` → cadence enqueues Rhea's `research` box job → she classifies → the resulting worthy landers feed **Cleo's modify-vs-build-new decision** ([[../libraries/cleo-blueprint]] `runCleoBlueprintSweep` — [[../specs/cleo-lander-blueprint]] Phase 2) → **whole-missing-funnel-type gaps** land as [[../tables/lander_blueprints]] rows + queue **Carrie** (`dr-content`) to fill copy per block → the finished blueprint is submitted to **Ada's build queue**. **Single-lever gaps** stay in Cleo's existing storefront-optimizer bandit path (unchanged).
- **Specs:** [[../specs/rhea-url-sensor]] ⏳ (M1 — slice 1 SENSOR only) · [[../specs/rhea-teardown-recipe]] ⏳ (M2 — Rhea's structured teardown recipe) · [[../specs/cleo-lander-blueprint]] ✅ (the teardown → build-new bridge — Cleo's judgment step) · [[../specs/carrie-dr-content]] ⏳ (Carrie's DR-content session — the creative half of the chain).

### DR-content fill (Carrie, downstream of Cleo)
**Carrie** is Growth's DR-content worker — the creative half of the acquisition-research chain, operating downstream of Cleo. She fills a queued [[../tables/lander_blueprints]] row's `content` bucket: per skeleton block writes intense/emotional/urgency-driven DR copy in her voice (benefit-traceable to our actives; mirroring the review-analysis customer phrases; never brand fluff) and per image slot classifies by PERSUASIVE JOB. **Generatable slots** (product / ingredient / mechanism-diagram / lifestyle-illustrative) → she emits a Nano Banana Pro prompt; the worker renders via [[../libraries/gemini]] `generateNanoBananaProCombine` composed from our real product hero and stores the result as a categorized [[../tables/product_media]] row (`source='generated'`, `category=<slot>`) — permanent product intelligence for the whole business. **Real-evidence slots** (before/after transformation, UGC selfie, testimonial photo, press/certification logo) → she NEVER fabricates a customer result; she opens a [[../tables/lander_content_gaps]] row with a plain-language description for the founder to supply the real thing. North-star: she generates within the leash; every claim about a customer routes UP for real-world supply.

- **Metric:** blueprints filled to `content_complete` on the first pass (share whose real-evidence gaps were already covered by existing [[../tables/product_media]]); founder-gap-resolution latency (time from `awaiting_upload` → resolved).
- **Loop:** Cleo enqueues a `dr-content` [[../tables/agent_jobs]] job carrying a blueprint id → Carrie's box lane reads the product intelligence + skeleton → per block writes DR copy + per-slot verdicts → the worker executes each verdict deterministically ([[../libraries/lander-blueprints]] SDK chokepoint: `writeCategorizedProductMedia` for generated assets · `openContentGap` for real-evidence gaps · `setBlueprintContent` for the bucket · `setBlueprintStatus` for the transition) → status advances to `content_complete` (zero open gaps) or `awaiting_upload` (else, gaps route to Max via [[../libraries/approval-inbox]] `ownerFunctionForKind('dr-content')='growth'`). Complete blueprints route to Ada's build queue via `build_submitted`.
- **Specs:** [[../specs/carrie-dr-content]] ⏳ (M1 — DR content store + Carrie's box lane + operating skill).
- **Lane docs:** [[../libraries/builder-worker]] § The `dr-content` lane · `.claude/skills/dr-content/SKILL.md` (Carrie's persona + real-vs-AI discipline + output contract).

### Media buyer (Bianca, under Max)
**Bianca** is Growth's media-buyer worker — the paid-social test-and-scale operator under Max, delivering the [[../specs/media-buyer-test-winner-loop]] mandate above. She launches capped creative tests into a [[../tables/media_buyer_test_cohorts]] test ad set (behind the Phase-1 [[../libraries/media-buyer-publish-gate]]), reads **cost-per-add-to-cart** as the early winner signal, then **promotes** proven winners / **kills** losers scientifically (CPA vs LTV-derived breakeven) / **replenishes** the cohort / **fatigue-refreshes** a tiring winner (`amplifyWinner` at fatigue_score ≥ 0.5) — all under ONE conservative [[../tables/iteration_policies]] version ([[../libraries/media-buyer-agent]]). She is **deterministic + gated**: never acts on untrusted attribution (the [[../tables/media_buyer_sensor_trust]] gate), runs **shadow-first** (audit-only recommendations) then **armed** only under the owner-vetoable arming gate, and self-corrects (mode-revert) on a bad streak. She **grades her own calls** against realized ROAS 3d+ later ([[../tables/media_buyer_action_grades]] via [[../libraries/media-buyer-grader]]) and reports ONE **digest** of each pass up to Max in #director-growth-max ([[../libraries/media-buyer-director-digest]]). North-star: she optimizes a bounded proxy (test-cohort CPA) and reports up; Max owns the objective and holds her leash. A deterministic Node lane in [[../libraries/builder-worker]] — no Max session (unlike Rhea/Carrie).
- **Live state (2026-07-10):** built + wired (cadence + grade + self-correcting crons registered) but **dormant** — no active `iteration_policies` row / no active cohort ⇒ zero autonomous actions. Wakes on a shadow-mode policy + a test cohort.
- **Persona:** `getPersona("media-buyer")` → Bianca 🎯 ([[../../src/lib/agents/personas]]).

### Storefront CRO
The storefront is **the** conversion surface — continuously lift predicted-LTV-per-visitor across the whole Amazing Coffee funnel, from first paint to renewal. Run by the **Storefront Optimizer**, this director's *graded employee* (the objective-owner in the CEO→role-agent→tool chain, [[../goals/ceo-mode]]). Never "done"; measured by a metric trend, not % complete.

- **Objective (single, Goodhart-resistant):** **predicted-LTV-per-visitor** = one-time conversions × one-time margin + subscription conversions × est-sub-LTV. Not raw CVR, not AOV — those are diagnostics under it. Fast loop decides on the proxy at significance; the ~4-month reconciler recalibrates the proxy against real cohort LTV.
- **Graded on (the KPIs the Director scores 1–10):** the objective trend per (product × lander-type × audience); **campaign-grade average** (hypothesis quality scored *separately* from result — a sound hypothesis that lost is a high grade); **experiment win-rate + regret**; and the truth-check — the reconciler showing the proxy didn't lie. Supporting diagnostics it must move: PDP/lander engagement, carry-to-pricing vs close, price-step conversion, sub-attach rate, AOV.

**Scope — everything on the conversion surface is a lever under this one objective:**
- **On-page chapters** (PDP + all 4 lander types): hero, copy, benefit chips, social proof, pricing-table, trust badges — the component-level lever map.
- **Chapter reorganization *is an experiment*, not a standing behavior.** Reordering chapters for more carry-to-pricing is a chapter-order *lever* — it goes through the bandit vs a holdout like any other, promotes on the proxy, and auto-rolls-back on regression. It is never a silent one-off edit. (The lowest-hanging fruit — reorder for click-to-pricing — is exactly this.)
- **Cart-recovery flows** — the abandoned-cart reminder sequence is a lever (timing, copy, incentive): the optimizer A/B-tests it against the same objective; it does **not** hand-tune it blind. ([[../lifecycles/storefront-checkout]] cart analytics.)
- **Lead-capture popup** — offer vs survey variant, trigger, copy: an A/B lever the optimizer owns.
- **Survey chapter** — question set, discount hook, placement: a lever.
  Cart/popup/survey are all DB-driven surfaces, so they're patch-testable (Tier-0 materialize) exactly like chapters — no code hand-off for content/config changes.

**Inputs it ever-evaluates (not just its own funnel):**
- Its own SDKs — [[../libraries/funnel-tree]] ("what") + chapter-diagnostics/bottleneck ("why") + [[../libraries/ltv]]. Reading playbook: [[../recipes/growth-funnel-reading]] (bakes into [[../libraries/growth-director]]).
- **Competitive gap analysis — consumed, not operated.** A **peer Competitor Research agent** operates the competitor-research tool ([[../libraries/landing-page-scout]] / ad-gap) and produces gap analysis (`lander_recommendations`: `route:"optimizer"` for A/B-testable rearrange/copy gaps, `route:"build"` for new-component gaps). The Storefront Optimizer *should* read that feed to propose *new chapters or better in-chapter content* (competitors run a comparison-table we don't → test one). Two peer tool-operators, each a bounded proxy, both answerable to this director — never one operating the other's tool. **Open wire:** the producer already writes `route:"optimizer"` rows; feeding them into `loadOptimizerBrief` is a pending Growth-owned integration spec.

**Compute (per [[../operational-rules]] § Compute tiers):** a Tier-0 deterministic loop (funnel read → bandit → materialize → learn → guardrails, all Inngest, free) + a **read-only box lane** (Max subscription, flat) for its reasoning kernel — hypothesis, content, spec drafting. It **never** holds a read-write box lane. When a test needs a capability that doesn't exist (video hero, comparison-table widget, new review type) it drafts a **spec** → routes to Ada/Platform's read-write box (build-or-request, mirroring the repair agent) → the new component becomes a future lever. Image/hero generation (Nano Banana Pro) is the one metered, owner-gated call.

**Autonomy (the leash):** autonomous within policy on **reversible** levers — copy, hero, chapter add/remove/**reorder**, cart/popup/survey content — on DB-driven surfaces, OFF-by-default + product-scoped (`storefront_optimizer_policy`, flipped by the Director's `storefront_optimizer_policy_activation` leash). **Approval-gated:** offer levers (a persist-to-renewal offer bleeds margin every cycle → margin-floor rail → owner/CFO approval) and any structural rewrite. Everything surfaces its reasoning + rails; hitting a rail escalates, never executes.

- **Reading playbook:** [[../recipes/growth-funnel-reading]] · **Agent mechanics:** [[../libraries/storefront-optimizer-agent]] · **Goal (folded, shipped M1–M6):** [[../goals/storefront-optimizer]].
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

- **Autonomous media-buyer supervision** — ✅ complete (folded 2026-07-09). Took the already-built Media Buyer loop ([[../specs/media-buyer-test-winner-loop]]) from dormant code to a live, supervised, self-correcting system over the Amazing Coffee + Superfood Tabs cohorts, honoring the CEO guardrail *shadow before armed, autonomous ad-spend stays human-vetoable*: M1 sensor trust ([[../libraries/media-buyer-policy-calibrator]] · [[../libraries/media-buyer__sensor-trust-probe]]) → M2 shadow-mode daily cadence ([[../inngest/media-buyer-cadence]] · [[../tables/media_buyer_shadow_reviews]]) → M3 owner-vetoable arming flip ([[../lifecycles/media-buyer-arming]] · [[../libraries/media-buyer-arming-gate]]) → M4 daily grading + auto-revert ([[../libraries/media-buyer-grader]] · [[../libraries/media-buyer-self-correcting]]). End-to-end home + status: [[../lifecycles/media-buyer-arming]] § Status / open work.
- Contributes to [[../goals/ceo-mode]] › **M2 — Growth Director** (first director prototype: ROAS/CAC analyst → CEO).

## Autonomy (cutover + rollback)

**Activated 2026-06-30 15:44 UTC** (`live=true, autonomous=true, updated_by='ceo'` on `function_autonomy('growth')`) via `scripts/apply-growth-live-autonomous.ts` — mirrors [[platform]]'s 2026-06-23 20:35 cutover. From this point [[../libraries/approval-router]] `resolveApprover` routes growth-owned approvals to the Growth director (no longer the CEO), the box-worker `growth-director` job leaves dormant mode, and the daily director-recap + grade rollup start producing real Growth data.

The Growth director's `function_autonomy('growth')` flag is the one switch that flips Growth from CEO-routed approvals to Growth-director auto-approval. The activation pipeline is the [[../specs/growth-director-live-autonomous-cutover]] spec — pre-flight gate (`scripts/check-growth-cutover-ready.ts`), then the flip (`scripts/apply-growth-live-autonomous.ts` or the Agents-hub toggle `POST /api/developer/agents/autonomy {function_slug:'growth', live:true, autonomous:true}`), then the post-flip surfaces verification (manual `director-recap-cron` run + `GET /api/developer/agents/grades?function=growth` rollup check).

**Rollback** — turning Growth back to CEO-routed is the same toggle in reverse, from the same Agents-hub surface: `POST /api/developer/agents/autonomy {function_slug:'growth', autonomous:false}`. The route's `if (!live) autonomous = false` invariant means clearing `live` also clears `autonomous`. Once `autonomous=false`, [[../libraries/approval-router]] `resolveApprover` walks past Growth and routes growth-owned approvals up to the CEO again; the dormant guards on the box-worker `growth-director` job, the daily Growth recap, and the grade rollup re-engage on the next poll. Idempotent + reversible: no DB cleanup, no replay — flip on, flip off.

## Status

Charter doc — planned. Specs under it appear on the roadmap board grouped under Growth. First spec: [[../specs/winning-static-creative-finder]].
