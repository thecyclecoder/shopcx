# Storefront Optimizer proposal review + approve cards ✅

**Owner:** [[../functions/growth]] · **Parent:** M4 — The Storefront Optimizer agent ([[../goals/storefront-optimizer]])
**Relates:** [[storefront-optimizer-agent]] (M4, shipped), [[storefront-optimizer-activation-gate]] (the policy surface), [[../dashboard/storefront__optimizer]], [[../libraries/storefront-optimizer-policy]]

Summary: M4 ([[storefront-optimizer-agent]]) proposes one campaign per due `(product × lander-type × audience)` as a `storefront_campaign` entry in [[../tables/agent_jobs]]`.pending_actions` with `status='needs_approval'` (when `auto_run_reversible=false`). The approval plumbing already exists end-to-end (`POST /api/roadmap/approve` → `approveRoadmapAction` flips the job to `queued_resume` → the worker resumes and `materializeCampaign` stands up the [[../tables/storefront_experiments]] row). **The only missing piece is the UI**: no dashboard renders these proposals as Build/Approve cards. `/dashboard/storefront/optimizer/page.tsx` tells the owner "proposes campaigns as Build/Approve cards — your tap runs each test" but renders only the policy toggles + guardrails; `/dashboard/roadmap/box` lists the paused jobs but `approvalHref('storefront-optimizer', …)` routes to `/dashboard/storefront/funnel`, which has no card for them. Result: the owner is blocked — currently 4 hero-swap proposals for Amazing Coffee are stuck unreachable. This spec wires the review/approve surface.

## Phase 1 — proposal list API ✅
- New `GET /api/workspaces/[id]/storefront-optimizer-proposals` (owner/admin) — return the workspace's `agent_jobs` rows `kind='storefront-optimizer'` AND `status='needs_approval'`, each unpacked into a card: `{ jobId, actionId, spec_slug (product:lander:audience), product name, lander_type, audience, lever, hypothesis/reasoning (from pending_action.preview), variant kind+label (hero vs content patch), created_at }`. Reuse the typed `OptimizerProposal`/`campaign_plan` shape already on the pending_action (scripts/builder-worker.ts).
- Read-only; no new table. Mirror the auth pattern of [[../dashboard/storefront__optimizer]]'s policy GET.

## Phase 2 — render Build/Approve cards on the optimizer dashboard ✅
- On `/dashboard/storefront/optimizer` add a "Proposed campaigns" section above the guardrails listing each card with: the lander type, the lever, the agent's reasoning (funnel signal + lever posterior it cited), the variant preview (for a `kind:'hero'` proposal, the hero prompt/label; for a content patch, the diff), and **Approve / Decline** buttons.
- Approve → `POST /api/roadmap/approve { jobId, actionId, decision:'approve' }` (the existing route — no new approval logic); Decline → `decision:'decline'`. On success optimistically drop the card and toast "Campaign queued — the agent is standing up the experiment."
- Empty state when none pending: "No proposals awaiting your approval." Keep the existing on/off + auto_run_reversible copy honest by pointing it at this section.
- (Optional, same phase) also surface a compact count badge on the funnel dashboard's running-experiments area, since `approvalHref` currently sends `storefront-optimizer` there — OR repoint `approvalHref('storefront-optimizer', …)` in `src/app/dashboard/roadmap/box/page.tsx` to `/dashboard/storefront/optimizer` (the real approve surface). Pick one and make the roadmap-box link land where the buttons are.

## Safety / invariants
- **No new approval path.** Approval goes through the existing `approveRoadmapAction` (owner-gated, flips to `queued_resume`); this spec only adds read + button surfaces. The optimizer agent still never writes its own policy or self-approves.
- **Owner/admin only** for both the list API and the approve action (mirror the policy PATCH role-gate).
- **Reversible-only auto-run unchanged** — this surface is the manual tap path; it does not alter the `auto_run_reversible` gate in [[../libraries/storefront-optimizer-policy]].
- Surfaces the agent's reasoning on every card (the supervisable-autonomy north star — a proposal the owner can't see the rationale for is a silent proxy-optimizer).

## Completion criteria
- The 4 currently-pending Amazing Coffee proposals (and any future ones) render as cards on `/dashboard/storefront/optimizer` with the agent's reasoning + variant preview.
- Tapping Approve stands up the `storefront_experiments` row via the existing worker path; Decline clears the proposal; the card disappears on success.
- The `/dashboard/roadmap/box` paused-callout link for `kind='storefront-optimizer'` lands on the surface that actually has the buttons.
- Owner/admin gated; non-members 403.

## Verification
- With the 4 pending jobs present, load `/dashboard/storefront/optimizer` as owner → expect a "Proposed campaigns" section with 4 cards (pdp/listicle/beforeafter/advertorial), each showing lever=image (hero), the cited funnel signal, and Approve/Decline.
- `GET /api/workspaces/<ws>/storefront-optimizer-proposals` as owner → 4 cards with `jobId`/`actionId`; as a non-member → 403.
- Tap Approve on one → `POST /api/roadmap/approve` returns the job; `select status from agent_jobs where id='<jobId>'` → `queued_resume`; after the worker runs, `select status, lander_type, lever from storefront_experiments where product_id='ea433e56-0aa4-4b46-9107-feb11f77f533' order by created_at desc limit 1` → a `running` experiment for that lander.
- Tap Decline on another → the pending_action marks declined and the card disappears; no experiment created.
- From `/dashboard/roadmap/box`, click a paused `storefront-optimizer` row → lands on the optimizer dashboard's Proposed campaigns section (not a dead funnel link).