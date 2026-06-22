# `src/lib/storefront/optimizer-agent.ts` — the Storefront Optimizer agent (campaign loop + build-or-request)

The capstone (M4) of the [[../goals/storefront-optimizer]] — the deterministic half of the standing **employee** agent that ties the foundations together. The box `claude -p` session ([[../specs/storefront-optimizer-agent]], run as `runStorefrontOptimizerJob` in [[../recipes/build-box-setup|builder-worker.ts]]) reasons read-only over the brief this module loads and emits a typed plan; this module is the dedup + enqueue discipline its scheduling cron honors and the WRITE the worker materializes from that plan. The agent **diagnoses + proposes**, the worker **executes on the gate's verdict** (mirrors [[migration-fix]] / [[repair-agent]]). Spec `docs/brain/specs/storefront-optimizer-agent.md`.

The campaign loop (one campaign = one hypothesis = one atomic lever): read state → form a CRO-grounded hypothesis → produce the variant → stand up an [[storefront-experiments|M1]] experiment vs holdout → decide/learn/report. Decide→learn (Phase 4) is **already wired** in the M1 refresh ([[storefront-experiment-refresh]] `commitLearning` → [[storefront-lever-memory|M2]] `updatePosterior`) — the `storefront_experiments` row IS the campaign record [[../specs/storefront-campaign-grading-loop|M5]] grades.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `loadOptimizerBrief` | `({ surface, now?, admin? }) → Promise<OptimizerBrief>` | Read-only campaign brief: the activation gate ([[storefront-optimizer-policy]]), next-best lever + ranked candidates (M2 `nextLeverToTest`), funnel chapter signal (`computeChapterPriorsFromFunnel`), predicted-LTV proxy (M3 `storefront_ltv_metrics`) + calibration state, live lander content. Returns the TEXT (the session reasons over it) + STRUCTURED fields (`policy`/`gate`/`candidates`/`conservative` the worker gates + materializes from). |
| `materializeCampaign` | `({ workspaceId, proposal, productId, conservative, createdBy?, patchOverride?, now?, admin? }) → Promise<MaterializeResult>` | The worker's WRITE: stand up the M1 experiment — `storefront_experiments` row (status `running`, carrying the `hypothesis`) + a control arm vs the variant arm. ≤1 active campaign per surface (refuses a second). Conservative mode reserves a bigger holdout. Rolls back the experiment if the variant insert fails. |
| `enqueueDueCampaigns` | `({ workspaceId, now?, admin? }) → Promise<EnqueueResult>` | The scheduling cron's worker ([[../inngest/storefront-optimizer]]): enqueue one `storefront-optimizer` [[../tables/agent_jobs]] cycle per DUE (product × lander-type × audience). Off unless the policy is active. Due = in-scope · no active campaign · no live job · next-best lever ≥ `MIN_LEVER_SCORE_TO_TEST`. Deduped + bounded. |
| `generateCampaignHero` | `({ workspaceId, productId, prompt, slug, admin? }) → Promise<string \| null>` | Worker-side Nano-Banana hero gen (the box session never calls the image API): composites the product's isolated pouch ([[gemini]] `generateNanoBananaProCombine`), compresses to webp, uploads to `product-media`, returns the public URL. Mirrors [[../lifecycles/advertorial-landers]] `ensureReasonsHero`. |
| `hasActiveCampaignForSurface` | `(admin, surface) → Promise<boolean>` | ≤1 active campaign per surface (a draft/running/promoted experiment occupies it). Best-effort. |
| `surfaceKey` | `({ product_id, lander_type, audience }) → string` | The deterministic dedup/spec key `product:lander:audience` (the `agent_jobs.spec_slug`). |
| tunables | `LANDER_TYPES`, `OPTIMIZER_AUDIENCES=['all']`, `MIN_LEVER_SCORE_TO_TEST=0.35`, `CONSERVATIVE_MIN_HOLDOUT=0.2`, `LIVE_OPTIMIZER_STATUSES`, `ACTIVE_EXPERIMENT_STATUSES` | |

## The typed plan (box session → worker)
The session emits ONE JSON object. `propose` (a reversible-lever campaign — copy/hero/chapter patch, the ONLY auto-run-eligible class) · `needs_build` (an offer / structural / missing-capability lever → author a scoped spec + surface a Build card, never faked) · `idle` (gate off / no worthwhile lever) · `needs_input` (a product decision). `OptimizerProposal` = `{ hypothesis, reasoning, lever_key, lever_class, lander_type, audience, holdout_pct?, variant:{label, kind:'content'|'hero', patch?|hero_prompt?} }`.

## Governance (the north star — CEO → Growth → Optimizer)
- **Gate first.** Every campaign passes [[storefront-optimizer-policy]] `evaluateProposalGate`: off-by-default · product-scoped · propose-and-approve unless a **reversible** lever is explicitly opted into `auto_run_reversible`. Offers + structural rewrites are **always** approval-gated.
- **Conservative until calibrated.** `loadOptimizerBrief` reads M3's `getCalibrationState`; `conservative=true` (uncalibrated) reserves a bigger holdout (smaller exposed bet). M1 already enforces conservative bandit thresholds via `isProxyCalibrated`.
- **Surfaces its reasoning.** Every proposal cites the funnel signal + the lever posterior; a silent optimizer is invisible to its supervisor.
- **Build-or-request, never fake.** A missing capability becomes a scoped spec committed to main + a surfaced Build card (owner-gated) — the agent never edits product code or auto-builds (mirror [[repair-agent]]).

## Gotchas
- **Read-only session, worker write.** The `claude -p` keeps read-only DB secrets and never mutates; the worker (`materializeCampaign` / `generateCampaignHero`) does every write — the gate's verdict decides auto-run vs surfaced-for-approval.
- **One atomic lever per campaign.** Clean attribution; never bundle two changes into one experiment.
- **`lever_key` must be a ranked candidate.** The worker rejects a `propose` whose lever isn't in the brief's M2 candidates (or whose class isn't `reversible`) → `needs_attention`, never a malformed experiment.
- **Phase 4 is M1's.** This module does NOT decide/promote/kill or commit learning — [[storefront-experiment-refresh]] does, on its daily cadence. The agent only authors the hypothesis/variant and reads the result.
