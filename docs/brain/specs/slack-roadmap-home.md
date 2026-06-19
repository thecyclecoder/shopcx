# Slack Roadmap Home — mirror the board to the App Home tab (view + build, not messages) 🚧

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

Slack is now great for *finishing* a build (notify + approve, [[slack-roadmap-console]]), but there's no way to *see and start* builds in Slack without scrolling chat. Mirror the roadmap board onto the **App Home tab** — the ShopCX app's persistent, app-owned Block Kit surface (not a message): specs grouped by status with **Build all** + per-phase **Build** buttons. Open the app in Slack → see the roadmap → tap to build → approve → done, never leaving Slack.

**Business outcome:** the full loop is reachable from Slack on a phone — visualize what's planned/in-progress/shipped and kick off builds, alongside the existing approve/notify flow.

## Phase 1 — App Home view (read) ✅
- ✅ Subscribe to `app_home_opened` (the existing `src/app/api/slack/events/route.ts`) → publish a Block Kit Home view via `views.publish`. Build the view from `getRoadmap()` ([[../libraries/brain-roadmap]]): specs grouped **In progress / Planned / Shipped**, each row = title + owner chip + a **live build-status** line (read `agent_jobs` via `getLatestJobsBySlug`, reusing the board's `jobChip`).
- ✅ Respect Block Kit limits (≤100 blocks, button caps) — cap rows per group (12/12/8), collapse Shipped to one line each, and add a "full board ↗" link to `/dashboard/roadmap`. New lib `src/lib/slack-home.ts` (`buildHomeView(workspaceId)` → `home` view) + `publishHome(token, slackUserId, view)`; `publishHomeView` (views.publish) added to `src/lib/slack.ts`.

## Phase 2 — Build actions (write) ✅
- ✅ Each spec row gets buttons: **Build all** (`action_id: roadmap_build:{slug}`) and per-phase **Build N** (`roadmap_build_phase:{slug}:{n}`, capped at 4/row), plus **Open** (`roadmap_home_open:{slug}`, URL → web detail). Routed through the existing `src/app/api/slack/interactions/route.ts` `block_actions` handler → `queueRoadmapBuild` (same path as the board's BuildButton); per-phase passes scoped `instructions` ("Build only {phase}…").
- ✅ **Owner-gated:** the Slack `user_id` → workspace member (`slack_user_id` on `workspace_members`) via [[../libraries/slack-identity]]; non-owners can view but build buttons **no-op with a modal "owners only"** (Home interactions carry no channel, so a modal replaces the ephemeral). roadmap-actions re-checks the gate server-side. Reuses [[slack-roadmap-console]]'s signature-verified interactions endpoint.
- ✅ After queueing, **re-publish the Home view** so the status line flips to "queued/building" immediately; ack within Slack's 3s window (enqueue → buildHomeView → publish → ack).

## Phase 3 — Optional Slack List mirror (PM table) ⏳ (deferred)
- ⏳ Sync specs into a native **Slack List** (one row per spec: Status `planned|in_progress|shipped`, Owner, phase count) for the at-a-glance board feel. Read-only mirror, refreshed on board change (or each Home open). The brain stays the source of truth; the List never drives builds (Home tab does).
- _Not built in this PR — explicitly optional. The Home tab already delivers the at-a-glance board feel; Slack Lists are a heavier API surface (separate scopes/list-id config) with no incremental loop benefit, so it's left as future work._

## Safety / invariants
- **Build actions owner-gated** (Slack user → owner role); the signature-verified interactions endpoint is the only entry. No new prod surface beyond the Home view + handlers.
- **Brain stays source of truth** — Slack mirrors it, never the reverse. The Home view is rebuilt from `getRoadmap()` each open (no drift).
- Block Kit limits → cap/paginate + link out; never silently truncate without a "full board" link.

## Slack-app config (one-time, owner does in Slack)
- App config → **App Home** → enable the **Home Tab**.
- **Event Subscriptions** → subscribe to `app_home_opened` (Request URL `https://shopcx.ai/api/slack/events` already exists).
- Interactivity Request URL already set (`/api/slack/interactions`).

## Completion criteria
- Opening ShopCX in Slack shows the roadmap on the **Home tab**, grouped by status, with live per-spec build status.
- An owner tapping **Build all** / **Build N** queues the build (the Home view refreshes to "queued"); non-owners are blocked with an ephemeral notice.
- (If Phase 3) a Slack List reflects specs + statuses.

## Related
[[slack-roadmap-console]] · [[../inngest/slack-roadmap-notify]] · [[../libraries/slack]] · [[roadmap-build-console]] · [[build-box-status-view]] · [[../dashboard/roadmap]] · [[../tables/agent_jobs]]
