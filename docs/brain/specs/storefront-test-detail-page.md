# Storefront test detail page — both-version previews + per-arm funnel stats ✅

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

## Phase 1 — tests index + detail page (both-arm preview + per-arm stats) ✅
A tests index + `[experimentId]` detail page reading `storefront_experiments`/`_variants` + `storefront_events`; per-arm preview link (owner-only, exposure-excluded) + the funnel metric table with lift-vs-control + win-probability. Brain: [[storefront-optimizer-agent]] · [[storefront-experiment-bandit-framework]] · [[../libraries/storefront-experiment-attribution]] · [[../libraries/storefront-experiment-funnel]] · [[../libraries/storefront-experiments]] · [[../tables/storefront_experiments]] · [[../dashboard/storefront__optimizer]].

**Landed:**
- Tests index `src/app/dashboard/storefront/optimizer/tests/page.tsx` + sidebar "Tests" link.
- Detail page `src/app/dashboard/storefront/optimizer/tests/[experimentId]/page.tsx`.
- APIs `GET /api/workspaces/[id]/storefront-experiments` (list) + `…/[experimentId]` (detail) — owner/admin only.
- `src/lib/storefront/experiment-funnel.ts` — per-arm funnel (bandit-source outcomes + event-derived engagement/ATC/lead + win-prob).
- `src/lib/storefront/experiments.ts` — `resolveExperimentsForRender` **preview mode** + `parsePreviewParam`/`renderVariantForLanderType`/`loadExperimentById`; lander route honors `?sx_preview=`.

**Engagement % definition (engineering choice, not pinned by the spec):** an exposed session is "engaged" if it fired any `chapter_view`/`chapter_dwell`/`scroll_depth` event; engagement % = engaged ÷ exposed sessions.

## Verification
- On `/dashboard/storefront/optimizer/tests` (as owner/admin) → expect a list of all the workspace's experiments, running/active first, each showing status · lander_type · lever · product · arm count · session count; clicking a row opens its detail page.
- On a running experiment's detail page (`/dashboard/storefront/optimizer/tests/{experimentId}`) → expect both arms side by side, and a funnel table where every metric (sessions, engagement %, ATC, lead, conversion, sub-attach, predicted-LTV/visitor, rev/visitor) is populated, non-control arms show **lift vs control** per metric, and a **win-probability vs control** row.
- Click an arm's **"Preview this version ↗"** link → expect the live lander to render with that arm's patch (control arm = current hero; variant arm = the generated hero), and **no new `experiment_exposure` row** for that visit (the link carries `sx_internal=1`; confirm via `select count(*) from storefront_events where event_type='experiment_exposure'` before/after, or that the session's `storefront_sessions.is_internal` is true).
- Cross-check the detail page's conversion/sub-attach/revenue/LTV against the bandit's persisted `storefront_experiment_variants` rollup columns for that experiment → expect them to match exactly (same source; the page and the promote/kill decision never disagree).
- Negative — fresh experiment: open the detail page of an experiment with zero exposures → expect every metric to read 0 / $0.00 (and win-prob "—"), not an error.
- Negative — non-owner: as a non-owner workspace member, `GET /api/workspaces/{id}/storefront-experiments/{experimentId}` (and the index API) → expect HTTP 403, so the tests pages and their preview links don't load.
