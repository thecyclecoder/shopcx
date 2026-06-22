# The Storefront Optimizer agent (campaign loop + build-or-request) ⏳

**Owner:** [[../functions/growth]] · **Parent:** M4 — The Storefront Optimizer agent
**Blocked-by:** [[storefront-experiment-bandit-framework]], [[storefront-lever-importance-memory]], [[storefront-ltv-proxy-reconciler]], [[storefront-optimizer-activation-gate]]

The capstone of the [[../goals/storefront-optimizer]] — the standing **employee** agent that ties the foundations together. Its boss is the [[../functions/growth|Growth director]], which sets its objective + guardrails and grades each campaign ([[storefront-campaign-grading-loop|M5]]); the chain is CEO → Growth → Optimizer ([[../operational-rules]] § North star). It is a new box [[../tables/agent_jobs|agent_jobs]] **`kind`** that runs the **campaign loop** (one campaign = one hypothesis, one atomic lever): read the funnel + the [[storefront-lever-importance-memory|lever-importance map]] → form a grounded hypothesis → produce the variant (a content/config patch, or a hero via the Nano-Banana skill [[../libraries/gemini]]) → stand up an [[storefront-experiment-bandit-framework|M1 Thompson-sampling bandit]] vs holdout → run to significance on the [[storefront-ltv-proxy-reconciler|M3 predicted-LTV proxy]] → promote winner / kill loser (auto-rollback handled by M1) → commit the learning to M2 memory → receive a grade. It is **autonomous within policy** (reversible copy/hero/chapter changes on DB-driven landers) and **approval-gated** for offers + structural rewrites. When a hypothesis needs a capability that doesn't exist, it **authors a spec → routes it to the build box** (the [[repair-agent]] build-or-request pattern), the component ships, and the new lever enters its toolbox — the optimizer *extends* the storefront over time. Scope: **Amazing Coffee × all four lander types** (PDP, listicle, before/after, advertorial). Serves predicted-LTV-per-visitor + a rising average campaign grade.

## Phase 1 — the `storefront-optimizer` agent_jobs kind + lane ⏳
- ⏳ planned
- Add a `kind='storefront-optimizer'` to [[../tables/agent_jobs]] (free-text kind, no migration — like `migration-fix`/`repair`); claim it on its own concurrency-limited lane in `scripts/builder-worker.ts` (`runStorefrontOptimizerJob`, a top-level `claude -p` on Max with read-only DB + the storefront tools, no `ANTHROPIC_API_KEY`).
- Trigger: a scheduled Inngest cron enqueues one campaign cycle per `(product × lander-type × audience)` due for a test (gated by `nextLeverToTest` having a worthwhile lever + no active experiment on that surface). Mirror [[box-escalation-triage]] / [[repair-agent]] enqueue-dedup discipline (≤1 active campaign per surface).

## Phase 2 — read state → form a grounded hypothesis ⏳
- ⏳ planned
- The agent reads: the [[../dashboard/storefront__funnel|funnel]] rollups ([[../tables/storefront_events]] chapter dwell / CTA share), the [[storefront-lever-importance-memory|lever-importance map]] (`nextLeverToTest`), the current predicted-LTV-per-visitor ([[storefront-ltv-proxy-reconciler]]), and the active lander content ([[../tables/advertorial_pages]] + PDP config).
- It emits ONE atomic hypothesis: a single lever on a single `(product × lander-type × audience)`, reasoned from the **CRO principles** (benefit/pain over features, hero dominant, pricing clarity #2, message-match, one clear CTA — the goal § CRO) — and **surfaces its reasoning** (the hypothesis cites the funnel signal + the lever's posterior).

## Phase 3 — produce the variant + stand up the campaign ⏳
- ⏳ planned
- Materialize the variant payload for the M1 framework: a content/config patch (copy/chapter add-remove-reorder) **or** a generated hero via `generateNanoBananaProCombine`/`generateNanoBananaProText` ([[../libraries/gemini]]) stored to the `ad-tool`/`product-media` path convention [[../tables/advertorial_pages]] uses.
- Create the `storefront_experiments` row + arms (M1 Phase 1) vs holdout and start it. The bandit + attribution + auto-rollback are M1's — the agent only authors the hypothesis/variant and reads the result.

## Phase 4 — decide → learn → report ⏳
- ⏳ planned
- On the M1 bandit reaching significance (or auto-rollback firing): promote the winner / confirm the kill, then **commit the learning to [[storefront-lever-importance-memory|M2 memory]]** via `updatePosterior` (win *or* loss), and write a campaign record (hypothesis, lever, variant, proxy result, decision) that [[storefront-campaign-grading-loop|M5]] grades.
- Report up: a campaign summary to the [[../functions/growth|Growth director]] surface (the report contract M5 defines) + the funnel dashboard.

## Phase 5 — missing-tool → build-or-request ⏳
- ⏳ planned
- When a hypothesis needs a capability that doesn't exist (a video hero, a comparison-table widget, a new review-widget chapter type), the agent does NOT fake it: it **authors a single-phase fix/feature spec** (`**Owner:** [[../functions/growth]]` + a parent, scoped) committed to main and **surfaces it for owner Build** (the [[repair-agent]] surface-don't-auto-build pattern — `needs_approval` + a `pending_actions` entry). Once the component ships, the new lever registers in [[storefront-lever-importance-memory|M2]]'s `storefront_levers` and enters the agent's toolbox.
- Default is **surface for one-tap Build**, never silent auto-build (the [[repair-agent]] north-star rationale: authoring code/PRs is higher-stakes autonomy, owner-gated).

## Safety / invariants
- **Autonomous only within policy.** Reversible copy/hero/chapter changes on DB-driven landers auto-run; **offer changes + structural rewrites are approval-gated** (offers are [[storefront-dynamic-renewal-offers|M6]], owner-approved — they bleed margin on every renewal). Hitting a guardrail **escalates**, never executes ([[../operational-rules]] § North star).
- **One atomic lever per campaign** — clean attribution; never bundle two changes into one experiment.
- **Surfaces its reasoning.** Every hypothesis cites the funnel signal + lever posterior it came from; a silent optimizer is invisible to its supervisor.
- **Conservative until calibrated.** Honors M3's `isProxyCalibrated` — smaller bets + tighter thresholds until the reconciler has calibrated once.
- **Build-or-request, never fake.** A missing capability becomes a surfaced spec for owner Build; the agent never edits product code directly or auto-builds (mirror [[repair-agent]]).
- **Hard CRO rails:** no disease claims, no fabricated stats, brand voice (supplement compliance is non-negotiable — the goal § hard rails).
- **Deduped + bounded queue:** ≤1 active campaign per `(product × lander-type × audience)`; an undiagnosable / stuck cycle surfaces, it doesn't loop.

## Completion criteria
- A `storefront-optimizer` agent_jobs kind runs on its own lane, enqueued per due `(product × lander-type × audience)`, deduped to ≤1 active campaign per surface.
- The agent reads funnel + lever map + proxy, emits ONE atomic, reasoning-cited hypothesis from the CRO principles, and stands up an M1 campaign (content patch or Nano-Banana hero) vs holdout.
- On significance/rollback it promotes/kills, commits the learning to M2 (win or loss), and reports a graded campaign record up to Growth.
- A hypothesis needing a missing capability authors a scoped spec and surfaces it for owner Build (no fake, no silent auto-build); a shipped component registers as a new lever.
- Offer/structural changes are routed to approval, never auto-executed; the agent honors `isProxyCalibrated`.
- Demonstrated end-to-end on Amazing Coffee across all four lander types.

## Verification
- With the worker running, enqueue a `storefront-optimizer` job for Amazing Coffee `(pdp, cold-meta)` → expect it claimed on its own lane (`runStorefrontOptimizerJob`) and driven to a terminal/surfaced state.
- `select status, kind, spec_slug, pending_actions from agent_jobs where kind='storefront-optimizer' order by created_at desc limit 1;` → for a normal cycle the agent created a `storefront_experiments` row (M1) with arms vs holdout and a hypothesis citing a funnel signal + lever posterior (in the job log).
- Enqueue a second cycle for the same surface while one is active → expect NO second job (deduped).
- Drive a campaign to significance (M1 bandit) → expect the winner promoted, a `storefront_lever_importance` posterior updated (M2 `updatePosterior`, win or loss), and a campaign record written for M5 grading.
- Give the agent a hypothesis requiring a non-existent widget (a video hero) → expect it authors a scoped spec to main + surfaces a `pending_actions` Build card (`needs_approval`), and does NOT auto-build or fake the lever.
- Hand it an offer-change hypothesis → expect it routed to approval (gated), not auto-executed; with `isProxyCalibrated=false` confirm it runs a conservative (smaller-share) campaign.
- Confirm a `storefront-optimizer` tile/lane is registered in the box worker + Control Tower (the optimizer is watched too).
