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

## Sub-routes

_None._

## API endpoints called

- `GET /api/workspaces/[id]/storefront-optimizer-policy` — load the policy (OFF defaults synthesized if no row) + the workspace's products for the scope picker.
- `PATCH /api/workspaces/[id]/storefront-optimizer-policy` — upsert the policy. **Owner/admin only.** Validates scope ids, booleans, and the numeric guardrails.

## Permissions

Read: all workspace members (the GET is auth-gated, not role-gated). Write: **owner/admin only** (the PATCH role-gates). The optimizer agent never writes the policy — only humans/Growth do here.

## Files touched

- `src/app/dashboard/storefront/optimizer/page.tsx` — the page itself
- `src/app/api/workspaces/[id]/storefront-optimizer-policy/route.ts` — the GET/PATCH control API
- `src/lib/storefront/optimizer-policy.ts` — the read-only gate M4 consumes ([[../libraries/storefront-optimizer-policy]])

---

[[../README]] · [[../../CLAUDE]]
