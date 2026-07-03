# Dashboard · developer/usage

Fleet usage cockpit — 4 Max Round Robin lanes + Codex account cards (tokens + rate-limit proximity, NEVER $), departments panel (rollupFleetCost per owner_function + fleet_budgets ceilings + breach flag), and API $ panel (real usage_cost_cents by model/purpose + cache-read split). Two-currency honesty. Claude limit = burn / discoverLimit(account, window_kind) once ≥1 wall is sampled, else 'learning…'; Codex limit = reported /status %. Owner-gated. Phase 3 of [[../archive.d/fleet-usage-cockpit]].

**Route:** `/dashboard/developer/usage`

## Features

**Page title:** Fleet usage cockpit

**Rendering:** `"use client"` component (client-side state + fetch). Wrapped in a `layout.tsx` `<Suspense fallback={null}>` boundary so the production build succeeds under `cacheComponents: true`.

**Sidebar placement:** rendered directly BELOW the Pulse link in the developer sidebar takeover (`src/app/dashboard/sidebar.tsx`), matching the peer treatment [[developer__pulse|Pulse]] gets — same visual weight, not a member of `DEVELOPER_GROUPS` in [[../libraries/developer-nav]].

## Panels

1. **Accounts** — 4 Max Round Robin cards + 1 Codex card. Each renders one 5-hour window sub-card + one weekly window sub-card. Per sub-card:
   - Total tokens for the window (SUM of `source='box'` + `source='mac'` snapshot rows, matching the [[../tables/account_usage_snapshots]] unique key).
   - Cache-read %, output tokens (cheap-cache signal — the lever the orchestrator pre-context split targets).
   - Discovered-limit badge: Claude → `burn / discoverLimit` once ≥1 wall is sampled ('N% of ~L (K walls)'); Claude with 0 walls → 'learning… (0 walls)' — **never a fabricated %**; Codex → `/status: P% (K walls)` from the reported `limit_pct`.
   - Capped chip + reset countdown when either window is capped.
2. **Departments** — a row per `owner_function` from [[../libraries/fleet-cost]] `rollupFleetCost`, joined against [[../tables/fleet_budgets]] via [[../libraries/fleet-spend-governor]] `listFleetBudgets`. Columns: tokens, `$` (only where a genuinely API-billed row contributed — Max lanes show 'subscription proxy'), token / `$` ceiling, window (days), breach status. Breach rule = `tokens > ceiling OR $ > ceiling`, matching `runFleetSpendGovernor`.
3. **API spend** — real `$` from [[../tables/ai_token_usage]] over the same window. Cards for total `$` / tokens / cache-read % / raw-input / output; top-6 lists by model + by purpose. Deeper drilldowns live on the workspace analytics page (`/api/workspaces/[id]/analytics/ai`).

## Sub-routes

_None._

## API endpoints called

- `/api/developer/usage` — the cockpit composition. Owner-gated (403 for non-owner). Response shape: `{ generated_at, accounts[], departments[], api }`.

## Permissions

**Owner only.** The client page checks `workspace.role === 'owner'` and renders a lock message otherwise. The route double-checks server-side against `workspace_members.role`.

## Files touched

- `src/app/dashboard/developer/usage/page.tsx` — the page itself
- `src/app/dashboard/developer/usage/layout.tsx` — the Suspense wrapper (cacheComponents)
- `src/app/api/developer/usage/route.ts` — the owner-gated GET composer
- `src/lib/usage-snapshots.ts` — `buildUsageCockpit`, `discoverLimit`, `AccountUsageSnapshotRow` (pure composition)
- `src/lib/developer-nav.ts` — `DEVELOPER_USAGE_HREF` + `DEVELOPER_USAGE_ICON` + `isInDeveloperPortal` membership
- `src/app/dashboard/sidebar.tsx` — the peer link directly BELOW Pulse

## Related

[[developer__pulse]] · [[../tables/account_usage_snapshots]] · [[../tables/usage_wall_events]] · [[../tables/agent_job_costs]] · [[../tables/ai_token_usage]] · [[../tables/fleet_budgets]] · [[../libraries/usage-snapshots]] · [[../libraries/fleet-cost]] · [[../libraries/fleet-spend-governor]] · [[../libraries/ai-usage]] · [[../libraries/developer-nav]] · [[../archive.d/fleet-usage-cockpit]] · [[../recipes/mac-usage-reporter]] · [[../functions/platform]]

---
