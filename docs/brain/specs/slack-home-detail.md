# Slack Home detail — make the App Home a destination, retire the List ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The App Home roadmap ([[slack-roadmap-home]]) is a **launcher, not a destination** — a spec row only links back to `/dashboard/roadmap/{slug}`, which defeats the point of Slack (if you're going to the app, why go through Slack?). And the native **Slack List** mirror, while pretty, has too many moving parts (scope-chase: `lists:read/write` + `files:read`, bot-owned standalone lists are hard to share, actions need Workflow Builder). **Retire the List; invest in the Home tab** as a self-contained surface: tap a spec → see its full detail and act, all in Slack.

**Business outcome:** review and build any spec end-to-end inside Slack — no outbound hop — on a surface that works on any plan with no extra scopes.

## Phase 1 — Retire the Slack List ⏳
- ⏳ Remove the List integration: delete `src/lib/slack-list.ts`, the `syncRoadmapList` calls in `src/app/api/slack/{events,interactions}/route.ts`, and the List helpers in `src/lib/slack.ts` (`createSlackList`, `*SlackListItem*`, schema types). Drop the `lists:read`/`lists:write` need.
- ⏳ Migration: `alter table workspaces drop column if exists slack_roadmap_list;` (idempotent). Remove [[../libraries/slack-list]] + the Phase-3 List section from [[../integrations/slack-roadmap-console]] / [[slack-roadmap-home]]; note the retirement.
- ⏳ (The live Slack List object is owner-deleted from the Slack UI — the bot lacks `files:write`.)

## Phase 2 — In-Slack spec detail modal ⏳
- ⏳ Tapping a spec row (a **Details** button / the title) opens a Block Kit **modal** (`views.open` via the `block_actions` `trigger_id`, handled in `src/app/api/slack/interactions/route.ts`). The modal renders, from `getRoadmap()`/`getSpec()`: **status, owner · parent, phases with ✅/🚧/⏳, the `## Verification` "how to test" steps, summary**.
- ⏳ Actions live IN the modal: **Build all**, per-phase **Build N**, **Mark verified & archive** (owner-gated, reusing `roadmap-actions`). "Open in ShopCX" demotes to a small footer link — the modal is the primary surface, not the launcher.

## Phase 3 — Home tab visual polish ⏳
- ⏳ Cleaner Home layout (`src/lib/slack-home.ts`): status sections with **counts** (`In progress 3 · Planned 6 · Shipped 12`), divider rows, owner chips, a compact one-line-per-spec format with a status emoji + a single **Details** affordance (not a wall of links). Header with the build-box health (`worker_heartbeats`) summary.

## Safety / invariants
- Owner-gated build/verify actions (Slack user → owner via [[../libraries/slack-identity]]); signature-verified interactions endpoint only.
- Brain stays source of truth; Home + modal rebuilt from `getRoadmap()`/`getSpec()` each open (no drift).
- Removing the List must not touch the Home tab / notify / approve paths (they don't depend on it).

## Completion criteria
- The List integration (code, column, scopes, brain pages) is gone; nothing references `slack_roadmap_list`.
- Tapping a spec in the Home tab opens a Slack **modal** with its status + phases + how-to-test + build/verify actions — **no outbound link required to review or build**.
- The Home tab reads cleanly (grouped + counts), not a list of links.

## Related
[[slack-roadmap-home]] · [[../integrations/slack-roadmap-console]] · [[../libraries/slack-home]] · [[verification-guides]] · [[roadmap-build-console]] · [[../tables/workspaces]]
