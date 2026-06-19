# libraries/slack-home

App **Home tab** for the [[../integrations/slack-roadmap-console|Slack Roadmap Console]] — mirrors the roadmap board onto the ShopCX app's persistent, app-owned Block Kit surface (NOT a message). Specs grouped **In progress / Planned / Shipped**, each row carrying a live build-status chip + **Build all** / per-phase **Build N** / **Open** buttons. **Pure rendering, no token spend**; the view is rebuilt from `getRoadmap()` ([[brain-roadmap]]) on every open, so it never drifts from the brain.

**File:** `src/lib/slack-home.ts`

## Exports

- `HOME` — the `action_id` **prefix** constants. The slug (and phase number) are embedded so a row's many buttons stay unique within an actions block:
  - `roadmap_build:{slug}` — Build all
  - `roadmap_build_phase:{slug}:{n}` — build one phase (scoped `instructions`)
  - `roadmap_home_open:{slug}` — URL button (no-op ack)
- `buildHomeView(workspaceId)` → a Block Kit `{ type: "home", blocks }` view. Reads `getRoadmap()` + live [[../tables/agent_jobs]] (`getLatestJobsBySlug`) + `getPendingFolds`; reuses [[slack-roadmap]]'s `jobChip` for the status chip. Grouped + **capped per group (12 / 12 / 8)** with a "full board ↗" link to `/dashboard/roadmap`; Shipped collapses to one line per spec (no build buttons). Per-phase buttons capped at 4/row (Block Kit ≤25 elements, view ≤100 blocks).
- `publishHome(token, slackUserId, view)` — thin wrapper over [[slack]] `publishHomeView` (`views.publish`).
- `noticeModal(title, text)` — a small modal for transient Home-tab feedback (Home interactions carry **no channel**, so a modal stands in for the ephemeral used in channel flows).

## Wiring

- **Read (Phase 1):** `app_home_opened` (tab `home`) on `src/app/api/slack/events/route.ts` → `buildHomeView` → `publishHome`.
- **Write (Phase 2):** `roadmap_build:*` / `roadmap_build_phase:*` button taps on `src/app/api/slack/interactions/route.ts` → owner-gated `queueRoadmapBuild` ([[roadmap-actions]]) → **re-publish** the Home view so the chip flips to "queued/building" immediately (ack within Slack's 3s window). Non-owners → `noticeModal("Owners only", …)`, nothing runs.

## Conventions

- **Brain stays source of truth** — the Home view is rebuilt from `getRoadmap()` each open + after each queued build (no drift). Slack mirrors the brain, never the reverse.
- Owner gate **twice**: Slack identity ([[slack-identity]]) is a UX filter; [[roadmap-actions]] re-checks server-side regardless of the payload.
- Never silently truncate — every capped group links out to the `/dashboard/roadmap` board.

## Callers

- `src/app/api/slack/events/route.ts` · `src/app/api/slack/interactions/route.ts`

## Related

[[../integrations/slack-roadmap-console]] · [[slack]] · [[slack-roadmap]] · [[slack-identity]] · [[roadmap-actions]] · [[brain-roadmap]] · [[../tables/agent_jobs]] · [[../dashboard/roadmap]]

---

[[../README]] · [[../../CLAUDE]]
