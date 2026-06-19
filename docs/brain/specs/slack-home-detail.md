# Slack Home detail — make the App Home a destination, retire the List ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The App Home roadmap ([[slack-roadmap-home]]) is a **launcher, not a destination** — a spec row only links back to `/dashboard/roadmap/{slug}`, which defeats the point of Slack (if you're going to the app, why go through Slack?). And the native **Slack List** mirror, while pretty, has too many moving parts (scope-chase: `lists:read/write` + `files:read`, bot-owned standalone lists are hard to share, actions need Workflow Builder). **Retire the List; invest in the Home tab** as a self-contained surface: tap a spec → see its full detail and act, all in Slack.

**Business outcome:** review and build any spec end-to-end inside Slack — no outbound hop — on a surface that works on any plan with no extra scopes.

## Phase 1 — Retire the Slack List ✅
- ✅ Removed the List integration: deleted `src/lib/slack-list.ts`, the `syncRoadmapList` calls in `src/app/api/slack/{events,interactions}/route.ts`, and the List helpers in `src/lib/slack.ts` (`createSlackList`, `*SlackListItem*`, `slackListCell`, schema types). The `lists:read`/`lists:write` scopes are no longer needed.
- ✅ Migration: `supabase/migrations/20260619170000_drop_workspace_slack_roadmap_list.sql` (`alter table workspaces drop column if exists slack_roadmap_list;`, idempotent) · apply `scripts/apply-drop-workspace-slack-roadmap-list-migration.ts`. Deleted [[../libraries/slack-list]]; scrubbed the List section from [[../libraries/slack]] / [[../integrations/slack-roadmap-console]] / [[../tables/workspaces]] / [[../lifecycles/roadmap-build-console]]; noted the retirement.
- ✅ (The live Slack List object is owner-deleted from the Slack UI — the bot lacks `files:write`.)

## Phase 2 — In-Slack spec detail modal ✅
- ✅ Tapping a spec row's **Details** button opens a Block Kit **modal** (`views.open` via the `block_actions` `trigger_id`, handled in `src/app/api/slack/interactions/route.ts`). `buildSpecModal` renders, from `getSpec()`: **status, owner · parent, phases with ✅/🚧/⏳, the `## Verification` "how to test" steps, summary**.
- ✅ Actions live IN the modal: **Build all**, per-phase **Build N**, **Mark verified & archive** (owner-gated, reusing `roadmap-actions`; verify gated to shipped specs with no active build/fold). After an action the modal updates in place (`views.update`) + the Home view re-publishes. "Open in ShopCX" demotes to a small footer link — the modal is the primary surface, not the launcher.

## Phase 3 — Home tab visual polish ✅
- ✅ Cleaner Home layout (`src/lib/slack-home.ts`): status sections with **counts** (`In progress 3 · Planned 6 · Shipped 12`), divider rows, owner chips, a compact one-line-per-spec format with a status emoji + a single **Details** affordance (a section accessory button, not a wall of links). Header with the build-box health (`worker_heartbeats`) summary (🟢 healthy / 🔴 down via last-poll recency).

## Safety / invariants
- Owner-gated build/verify actions (Slack user → owner via [[../libraries/slack-identity]]); signature-verified interactions endpoint only.
- Brain stays source of truth; Home + modal rebuilt from `getRoadmap()`/`getSpec()` each open (no drift).
- Removing the List must not touch the Home tab / notify / approve paths (they don't depend on it).

## Completion criteria
- The List integration (code, column, scopes, brain pages) is gone; nothing references `slack_roadmap_list`.
- Tapping a spec in the Home tab opens a Slack **modal** with its status + phases + how-to-test + build/verify actions — **no outbound link required to review or build**.
- The Home tab reads cleanly (grouped + counts), not a list of links.

## Verification
_Prereq: the migration `scripts/apply-drop-workspace-slack-roadmap-list-migration.ts` has been applied to prod, the Slack app is connected, and your Slack user is mapped to the workspace owner._

- In Slack, open the **ShopCX app → Home tab** → expect a "🗺️ ShopCX Roadmap" header, a counts line (`In progress N · Planned N · Shipped N`) + a build-box health line (🟢 healthy `<sha>` when the box polled in the last 90s, else 🔴 down), then specs grouped **In progress / Planned / Shipped** with a `· N` count per group — each spec one line (status emoji + title + chip + owner) with a single **Details** button, no per-row Build/Open buttons.
- On the Home tab, tap **Details** on any spec → expect a modal titled with the spec name showing `slug · status · chip`, **Owner · Parent**, summary, a numbered **Phases** list (✅/🚧/⏳), the **How to verify in prod** steps (when the spec has a `## Verification`), and a footer **Open in ShopCX ↗** link.
- As the **owner**, in a planned/in-progress spec's modal, tap **🛠️ Build all** → expect the modal to update in place to a "Queued" confirmation, and reopening Details (or the Home tab) shows the spec's chip as `⏳ queued`/`🛠️ building`.
- As the owner, in a spec with >1 phase, tap **Build 2** → expect a queued build whose `instructions` scope it to phase 2 only.
- As the owner, on a **Shipped — awaiting verification** spec's modal, tap **✅ Mark verified & archive** → expect a "Verified" confirmation and the row chip flips to `🗂️ Folding…` (a batch fold-build was queued); the Mark-verified button is absent for non-shipped specs or ones already building/folding.
- As a **non-owner** mapped user, open a spec's Details → expect the full detail to render but **no action buttons** (an "_Building is reserved for the workspace owner._" note instead); tapping any build path still no-ops server-side.
- In the DB, `select column_name from information_schema.columns where table_name='workspaces' and column_name='slack_roadmap_list'` → expect **zero rows**; `grep -rn "slack_roadmap_list\|syncRoadmapList\|slack-list" src` → expect no matches.

## Related
[[slack-roadmap-home]] · [[../integrations/slack-roadmap-console]] · [[../libraries/slack-home]] · [[verification-guides]] · [[roadmap-build-console]] · [[../tables/workspaces]]
