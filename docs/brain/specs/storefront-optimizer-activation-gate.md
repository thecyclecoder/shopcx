# Storefront Optimizer — activation + product-scope gate (OFF by default) ⏳

**Owner:** [[../functions/growth]] · **Parent:** the control surface for [[../goals/storefront-optimizer]]; gates [[storefront-optimizer-agent|M4]] + [[storefront-experiment-bandit-framework|M1]]. · **Found in design 2026-06-22:** the optimizer specs say the agent "auto-runs within policy" + scope is "Amazing Coffee" — but **no policy object / on-switch / enforced scope exists**. As spec'd, once M4's cron ships it would **auto-run live experiments on customer traffic with no explicit owner enablement** — violating supervisable autonomy. The ad iteration engine got this right (`iteration_policies.policy_active` → "no active policy, zero autonomous actions"); the storefront side must mirror it.

## Model — mirror `iteration_policies`, OFF by default
- **A `storefront_optimizer_policy` row** (per workspace): `active boolean DEFAULT false`, `product_scope` (an allowlist of `product_id`s the optimizer may touch — empty/explicit ⇒ Amazing Coffee only to start), plus the editable guardrails the agent reads (max concurrent experiments, min sample, holdout %, auto-rollback thresholds). Agent-legible + agent-writable (typed, versioned, authored) so the **Growth director** operates it later — the optimizer engine **never writes its own policy** (same split as the ad engine).
- **OFF by default ⇒ propose-only.** With `active=false` (or a product not in `product_scope`), the agent still runs the full loop — reads the funnel + lever map, forms hypotheses, **surfaces what it *would* test** — but **stands up ZERO `running` experiments / assigns zero live variants / writes no lander changes.** It's a dry-run you can watch. Flipping `active=true` is the explicit "go."
- **Scope is enforced, not narrative.** Every campaign-enqueue + experiment-activation checks `product_id ∈ product_scope`. Amazing Coffee is the only scoped product until the owner widens it — so it *cannot* touch another product even if a lander exists.
- **The switch is the owner/Growth control surface** (a dashboard toggle + per-product scope), surfaced on the storefront/optimizer view. Approval-gated levers (offers/structural) stay approval-gated regardless of the switch.

## Verification
- Fresh install / `active=false` → the optimizer cron runs, the agent **proposes** campaigns (visible), but `select count(*) from storefront_experiments where status='running'` = 0, no `experiment_exposure` events fire, no `advertorial_pages`/PDP changes are written. Nothing reaches a customer.
- Flip `active=true` with `product_scope=[amazing-coffee]` → it begins running experiments **only** on Amazing Coffee; an experiment on any other product is refused/never enqueued (scope-enforced, not just unscheduled).
- A reversible lever on an in-scope product auto-runs (within the policy guardrails); an offer/structural lever still requires approval even when active.
- Flip `active=false` → in-flight experiments stop promoting/launching new arms (graceful), no NEW running experiments; the agent reverts to propose-only.
- Negative: with the gate OFF, there is no path by which the agent mutates live storefront content or assigns a live variant.

## Phase 1 — the policy table + OFF-by-default gate + product scope + the toggle ⏳
`storefront_optimizer_policy` (active=false default, product_scope, guardrails); M4 + M1 read it (propose-only when inactive / out-of-scope, enforce scope on enqueue + activation); a dashboard on/off toggle + per-product scope (the Growth control surface). Brain: [[../goals/storefront-optimizer]] · [[storefront-optimizer-agent]] · [[storefront-experiment-bandit-framework]] · [[../operational-rules]] (§ North star) · mirrors [[storefront-iteration-engine]] `iteration_policies`.
