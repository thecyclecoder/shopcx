# Dashboard · storefront/optimizer

The Growth control surface for the Storefront Optimizer agent (M4) — the on/off
switch, the enforced product scope, the `auto_run_reversible` opt-in, and the
editable guardrails. OFF by default: while off the agent does not even propose;
while on it proposes campaigns as Build/Approve cards (the owner's tap runs each
test). See [[../specs/storefront-optimizer-activation-gate]].

**Route:** `/dashboard/storefront/optimizer`

## Features

**Page title:** Storefront Optimizer

**Rendering:** `"use client"` component (client-side state + fetch; auto-saves each change via PATCH).

**Master on/off:** toggles [[../tables/storefront_optimizer_policy]] `active`. OFF ⇒ the agent is fully idle.

**Product scope:** a checklist of the workspace's products writing `product_scope` (an enforced [[../tables/products]].id allowlist). The API validates every id belongs to the workspace.

**Auto-run reversible:** toggles `auto_run_reversible` — lets reversible copy/hero/chapter levers run without the per-campaign tap. Offer/structural levers stay approval-gated regardless.

**Guardrails:** editable `max_concurrent_experiments`, `min_sample`, `holdout_pct`, `auto_rollback_ltv_tolerance`, `auto_rollback_windows`, `auto_rollback_refund_spike_delta` (fractions where `*_pct`/`*_tolerance`/`*_delta`).

**Proposed campaigns (Build/Approve cards):** each pending `storefront-optimizer` proposal renders as a card ([[../specs/storefront-optimizer-proposal-cards]]). A **content** (copy/chapter) lever shows **Approve / Decline** and materializes on approve. A **hero** lever runs the **preview gate** ([[../specs/optimizer-hero-preview-gate]]): **Approve concept → generate preview** (the worker generates the candidate hero, doesn't go live), then the card re-appears showing the **actual generated image** with **Approve & go live / Reject with notes (free-text) / Cancel campaign**. Reject regenerates with the notes (rejected attempts shown as thumbnails); only the image-approval stands up the experiment. Approve/decline/reject all POST the existing `/api/roadmap/approve` (`reject` carries `notes`); no new approval route.

## Sub-routes

**Tests index — `/dashboard/storefront/optimizer/tests`** ([[../specs/storefront-test-detail-page]] Phase 1). `"use client"`. Lists **every** experiment in the workspace (active/running first, then promoted/draft/rolled_back/killed; newest within a status), each a card with status, lander_type, lever, product, hypothesis, arm count + total exposed sessions, linking into its detail page. Reads `GET /api/workspaces/[id]/storefront-experiments`. **Owner/admin only.**

**Test detail — `/dashboard/storefront/optimizer/tests/[experimentId]`**. `"use client"`. Renders each **arm side by side**:
- **Per-arm preview link** — `/store/{slug}/{handle}?variant=…&sx_preview=<experimentId>:<variantId>&sx_internal=1` opens the live lander with **that arm's patch forced** (control = current hero; variant = the generated hero). `sx_preview` forces the arm in the lander render ([[../libraries/storefront-experiments]] `resolveExperimentsForRender` preview mode); the paired `sx_internal=1` drops the emitted exposure at the pixel write, so the **bandit is never polluted**. Owner-only (the API is owner/admin-gated).
- **Per-arm funnel table** — sessions, engagement %, ATC rate, lead rate, conversion rate, sub-attach rate, predicted-LTV/visitor, revenue/visitor, each with **lift vs control**, plus the **win-probability vs control** row. Built by [[../libraries/storefront-experiment-funnel]] — outcome counts read from the persisted rollups the bandit decides on (no divergent math); engagement/ATC/lead derived from [[../tables/storefront_events]]; win-prob is the bandit's Monte-Carlo posterior.
- **Status + hypothesis/lever/audience/holdout/started_at**, read-only (the autonomous bandit drives promote/kill — this page observes + previews).

## API endpoints called

- `GET /api/workspaces/[id]/storefront-optimizer-policy` — load the policy (OFF defaults synthesized if no row) + the workspace's products for the scope picker.
- `PATCH /api/workspaces/[id]/storefront-optimizer-policy` — upsert the policy. **Owner/admin only.** Validates scope ids, booleans, and the numeric guardrails.
- `GET /api/workspaces/[id]/storefront-optimizer-proposals` — list the workspace's pending `storefront-optimizer` proposals ([[../tables/agent_jobs]] `kind='storefront-optimizer'`, `status='needs_approval'`), each unpacked from its `pending_action` into a Build/Approve card (`spec_slug` `product:lander:audience`, product name, lander_type, audience, lever, the agent's reasoning, the variant preview — hero prompt/label or content diff). **Owner/admin only**; read-only, no new table. The **Proposed campaigns** section above the guardrails renders these; Approve/Decline POST the existing `/api/roadmap/approve` (no new approval path). See [[../specs/storefront-optimizer-proposal-cards]].
- `GET /api/workspaces/[id]/storefront-experiments` — the tests index. **Owner/admin only.**
- `GET /api/workspaces/[id]/storefront-experiments/[experimentId]` — one experiment + product + per-arm funnel ([[../libraries/storefront-experiment-funnel]]) + per-arm preview links. **Owner/admin only.**

## Permissions

Read: all workspace members (the GET is auth-gated, not role-gated). Write: **owner/admin only** (the PATCH role-gates). The optimizer agent never writes the policy — only humans/Growth do here.

## Files touched

- `src/app/dashboard/storefront/optimizer/page.tsx` — the control surface
- `src/app/dashboard/storefront/optimizer/tests/page.tsx` — the tests index
- `src/app/dashboard/storefront/optimizer/tests/[experimentId]/page.tsx` — the test detail page
- `src/app/api/workspaces/[id]/storefront-optimizer-policy/route.ts` — the GET/PATCH control API
- `src/app/api/workspaces/[id]/storefront-experiments/route.ts` — the tests index API
- `src/app/api/workspaces/[id]/storefront-experiments/[experimentId]/route.ts` — the detail API
- `src/lib/storefront/experiment-funnel.ts` — the per-arm funnel rollup ([[../libraries/storefront-experiment-funnel]])
- `src/lib/storefront/experiments.ts` — `resolveExperimentsForRender` preview mode + `parsePreviewParam`/`renderVariantForLanderType` ([[../libraries/storefront-experiments]])
- `src/lib/storefront/optimizer-policy.ts` — the read-only gate M4 consumes ([[../libraries/storefront-optimizer-policy]])

---

[[../README]] · [[../../CLAUDE]]
