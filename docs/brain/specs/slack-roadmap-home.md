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

## Phase 3 — Optional Slack List mirror (PM table) ✅
- ✅ Sync specs into a native **Slack List** (one row per spec: **Spec** title, **Status** `⏳/🚧/✅`, **Owner**, **Phases** count, **Slug**) for the at-a-glance board feel. Read-only mirror, refreshed on board change + each Home open. The brain stays the source of truth; the List never drives builds (Home tab does). New lib `src/lib/slack-list.ts` (`syncRoadmapList(workspaceId)`) reconciles the List to `getRoadmap()` — create new rows, update drifted cells, delete rows whose slug no longer maps to a spec; diff key = slug; steady state = one `items.list` read + zero writes.
- ✅ Six Slack Lists API wrappers added to `src/lib/slack.ts` (`createSlackList`, `listSlackListItems`, `createSlackListItem`, `updateSlackListItem`, `deleteSlackListItem`, `slackListCell`). The List handle (`F…` id + generated column-id map) is cached on `workspaces.slack_roadmap_list` (jsonb, new column) so syncs reconcile the same List. Wired best-effort + non-throwing into the Home-open (`events`) and post-build (`interactions`) hooks — a Lists failure (e.g. scopes not yet granted) never affects the Home view or a build.
- _Requires one-time owner config: bot scopes `lists:read` + `lists:write` (reinstall). With those absent, sync no-ops and the Home tab is unaffected._

## Safety / invariants
- **Build actions owner-gated** (Slack user → owner role); the signature-verified interactions endpoint is the only entry. No new prod surface beyond the Home view + handlers.
- **Brain stays source of truth** — Slack mirrors it, never the reverse. The Home view is rebuilt from `getRoadmap()` each open (no drift).
- Block Kit limits → cap/paginate + link out; never silently truncate without a "full board" link.

## Slack-app config (one-time, owner does in Slack)
- App config → **App Home** → enable the **Home Tab**.
- **Event Subscriptions** → subscribe to `app_home_opened` (Request URL `https://shopcx.ai/api/slack/events` already exists).
- Interactivity Request URL already set (`/api/slack/interactions`).
- **(Phase 3)** OAuth & Permissions → add bot scopes **`lists:read`** + **`lists:write`** → reinstall the app. Then open the App Home (or queue a build) once to create + share the List. Until granted, the List mirror silently no-ops.

## Completion criteria
- Opening ShopCX in Slack shows the roadmap on the **Home tab**, grouped by status, with live per-spec build status.
- An owner tapping **Build all** / **Build N** queues the build (the Home view refreshes to "queued"); non-owners are blocked with an ephemeral notice.
- (Phase 3) a native Slack List reflects specs + statuses, kept in sync from the brain.

## Verification (Phase 3 — Slack List mirror)
- Prereq: in the Slack app, add bot scopes `lists:read` + `lists:write` and reinstall (without them every check below no-ops by design — confirm separately by checking server logs show `createSlackList error: missing_scope`).
- In Supabase, run `select slack_roadmap_list from workspaces where id = '{workspaceId}'` → before first sync expect `null`.
- Open the ShopCX app's **Home tab** in Slack once → expect a new List named **🗺️ ShopCX Roadmap** to exist, and `workspaces.slack_roadmap_list` to now hold `{ "id": "F…", "cols": {…} }`.
- Open that List → expect one row per in-flight spec with columns **Spec** (title), **Status** (⏳/🚧/✅ label), **Owner**, **Phases** (a number), **Slug**; the row set + statuses match `/dashboard/roadmap`.
- From the Home tab, tap **Build all** on a spec (owner) → after the queued build the List's **Status** cell for that spec stays consistent with the board (no duplicate row is created for the same slug).
- Edit a spec's phase emoji in `docs/brain/specs/{slug}.md` (or add/remove a spec) and re-open the Home tab → expect the List row's Status/Phases to update in place (drifted cells only) and removed specs' rows to disappear; unchanged specs cause zero writes.
- Re-open the Home tab repeatedly with no brain change → expect the List to stay identical (steady state = one `items.list` read, no create/update/delete).

## Related
[[slack-roadmap-console]] · [[../inngest/slack-roadmap-notify]] · [[../libraries/slack]] · [[../libraries/slack-list]] · [[roadmap-build-console]] · [[build-box-status-view]] · [[../dashboard/roadmap]] · [[../tables/agent_jobs]] · [[../tables/workspaces]]
