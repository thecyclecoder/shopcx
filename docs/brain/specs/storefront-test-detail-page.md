# Storefront test detail page — both-version previews + per-arm funnel stats ⏳

**Owner:** [[../functions/growth]] · **Parent:** the owner-facing view for [[storefront-optimizer-agent]] experiments; extends the optimizer/funnel dashboards. · **Requested 2026-06-23:** the owner needs a place to actually *see* each running A/B test — **preview links for both versions** (control + variant) and **per-version stats** (sessions, engagement %, add-to-cart rate, lead rate, conversion rate, predicted LTV, …) — to judge a test at a glance and decide promote/kill.

## The page (`/dashboard/storefront/optimizer/[experimentId]` or a tests index → detail)
Per experiment, render the arms **side by side** (control vs variant(s) vs holdout) with:
- **Preview link per arm** — a link that renders the live lander with that arm's variant patch applied (e.g. `/{handle}?variant=…&sx_preview=<experimentId>:<variantId>`), **owner-only + flagged as a preview so it does NOT emit an exposure / pollute the bandit** (reuse the `sx_internal` exclusion). So the owner sees exactly what a shopper in that arm sees — control's current hero vs the variant's generated hero.
- **Per-arm funnel stats** (from `storefront_experiment_variants` rollups + `storefront_events` exposures):
  - **Sessions** (exposures) · **Engagement %** (chapter dwell / scroll-depth share from `storefront_events`) · **Add-to-cart rate** (ATC / sessions) · **Lead rate** (email/OTP capture / sessions) · **Conversion rate** (orders / sessions) · **Sub-attach rate** · **Predicted LTV / visitor** (the M3 proxy) · **revenue / visitor**.
  - Show **lift vs control** on each metric + the **bandit win-probability** and **significance/holdout** state.
- **Status + controls:** running｜promoted｜killed｜rolled_back, the hypothesis + lever, started_at, and (if owner) promote/kill where appropriate — but the autonomous bandit still drives promote/kill; this page is primarily *observe + preview*.
- A **tests index** (all experiments for the workspace, newest/active first) linking into each detail page.

## Data sources (reuse, don't re-derive)
- Arms + posteriors: `storefront_experiments` + `storefront_experiment_variants` (alpha/beta or reward_sum/n, sessions/conversions/sub_attach/revenue/ltv_proxy).
- Engagement: `storefront_events` (chapter_view/dwell/scroll_depth/CTA per exposed session, joined on the exposure's variant_id).
- Reuse the existing attribution rollup ([[../libraries/storefront-experiment-attribution]]) — the page reads the same numbers the bandit decides on (no divergent math).

## Verification
- Open a running experiment's detail page → both arms shown side by side; each metric (sessions, engagement %, ATC, lead, conversion, sub-attach, predicted-LTV/visitor, rev/visitor) is populated from the rollups with **lift vs control** + win-probability.
- Click an arm's **preview link** → the lander renders with that arm's patch (control = current hero; variant = the generated hero) and **no `experiment_exposure` row is written** for the preview (owner/internal-flagged), so the bandit isn't polluted.
- The tests index lists all experiments; clicking one opens its detail.
- Numbers **match** what the optimizer/bandit uses (same attribution source) — the detail page and the promote/kill decision never disagree.
- Negative: an experiment with no exposures yet shows zeroes (not an error); a non-owner can't load the preview link.

## Phase 1 — tests index + detail page (both-arm preview + per-arm stats) ⏳
A tests index + `[experimentId]` detail page reading `storefront_experiments`/`_variants` + `storefront_events`; per-arm preview link (owner-only, exposure-excluded) + the funnel metric table with lift-vs-control + win-probability. Brain: [[storefront-optimizer-agent]] · [[storefront-experiment-bandit-framework]] · [[../libraries/storefront-experiment-attribution]] · [[../tables/storefront_experiments]] · [[../dashboard/storefront__optimizer]].
