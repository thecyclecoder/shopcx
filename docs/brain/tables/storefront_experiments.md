# `storefront_experiments` — one row per on-site experiment hypothesis

One row per hypothesis under test on the storefront: a `(product × lander_type × audience × lever)` tuple with a lifecycle status and a holdout. The arms live in [[storefront_experiment_variants]]; the bandit-refresh audit trail lives in [[storefront_experiment_runs]]. Written + driven by [[../libraries/storefront-experiments]] (assignment) + [[../libraries/storefront-bandit]] (decisions) + [[../inngest/storefront-experiments]] (the refresh). Migration `20260623120000_storefront_experiments.sql`. RLS: workspace-member SELECT, service-role write. Part of the [[../goals/storefront-optimizer]] (M1). See spec `docs/brain/specs/storefront-experiment-bandit-framework.md`.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` / `product_id` | uuid → workspaces / products | cascade |
| `lander_type` | text | `pdp` \| `listicle` \| `beforeafter` \| `advertorial` (CHECK). Maps to the storefront render `?variant=`: `advertorial`→advertorial, `beforeafter`→beforeafter, `listicle`→`?variant=reasons`. `pdp` = the bare PDP (data-model supported; render-time patching of the SSG PDP is out of M1 scope — see gotchas). |
| `audience` | text | audience key (default `'all'`); the ad engine's audience this experiment targets |
| `lever` | text | the lever under test (e.g. `headline`, `hero`, `chapter_order`) — human label |
| `hypothesis` | text | optional free-text hypothesis |
| `status` | text | `draft` \| `running` \| `promoted` \| `killed` \| `rolled_back` (CHECK) |
| `holdout_pct` | numeric | fraction held out to control, `[0,1]` (CHECK), default `0.10` |
| `promoted_variant_id` | uuid → [[storefront_experiment_variants]] | set when the bandit promotes a winner; render serves it to non-holdout traffic. FK `on delete set null` |
| `regression_windows` | int | Phase 5 — consecutive windows a running/promoted arm has sat below control on the LTV proxy; auto-rollback at `>=2` |
| `rollback_reason` | text | why the guardrail rolled it back (set with `status='rolled_back'`) |
| `last_decision` | jsonb | last decision snapshot — posterior win-probs + the rule invoked (supervisability) |
| `created_by` | uuid | who created the experiment (nullable) |
| `started_at` / `stopped_at` / `rolled_back_at` | timestamptz | lifecycle stamps |
| `created_at` / `updated_at` | timestamptz | |

**Indexes:** `(workspace_id, status)`; `(workspace_id, product_id, lander_type, status)` — the render-time active-experiment lookup.

## Lifecycle (status)
- `draft` → not served. `running` → bandit allocates exposures across arms (incl. control/holdout). `promoted` → a winner crossed the threshold; render serves `promoted_variant_id` to all non-holdout traffic. `killed` → a clear loser; not served (control restored). `rolled_back` → Phase-5 guardrail flipped it on an LTV-proxy regression / refund spike; not served, escalated to Growth.
- Only `running` + `promoted` experiments are served at render; every other status renders the unpatched (control) lander — so promote/kill/rollback is a pure status flip, never a content deploy.

## Gotchas
- **Holdout is sacred.** Every experiment carries exactly one `is_control` arm ([[storefront_experiment_variants]] partial unique index); the bandit may starve a losing arm but never the control.
- **Reversible levers only.** A variant payload is a content/config patch (copy/hero/chapter) — never a code deploy, never an offer/pricing change.
- **`pdp` lander_type is data-model only in M1.** The bare PDP is statically generated (ISR, reads no cookies) for sub-100ms edge TTFB; applying a per-visitor patch there would force it dynamic. Render-time patching is wired for the advertorial-family landers (advertorial/beforeafter/listicle) — the route that already runs dynamically via `?variant=&angle=`. A `pdp` experiment can still hold variants + accrue attribution; serving its patch needs a dynamic PDP (out of scope).
- **Conservative until calibrated.** Promote thresholds + non-control traffic share stay tight until M3's [[../goals/storefront-optimizer|LTV-proxy reconciler]] calibrates once; the conservative flag is read at refresh time (defaults to `true` while M3 is absent).
