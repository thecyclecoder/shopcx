# libraries/slack-list

Native **Slack List** mirror of the roadmap (slack-roadmap-home Phase 3) — a typed PM table where each row is a spec (**Spec** title · **Status** · **Owner** · **Phases** · **Slug**), for the at-a-glance board feel inside Slack. **Read-only mirror:** the brain (`docs/brain/specs/*.md` via `getRoadmap()` [[brain-roadmap]]) stays the source of truth; this only reconciles the List to match. The List **never drives builds** — that's the App Home tab ([[slack-home]]).

**File:** `src/lib/slack-list.ts`

## Exports

- `syncRoadmapList(workspaceId)` → `{ ok, created?, updated?, deleted?, error? }`. Reconciles the workspace's Slack List to `getRoadmap()`: **create** rows for new specs, **update** rows whose cells drifted, **delete** rows whose slug no longer maps to a spec. **Best-effort + non-throwing** — any failure (e.g. `lists:*` scopes not granted) returns `{ ok:false }` and leaves the List as-is; it never affects the Home view or a queued build.

## How it works

- **Diff key = spec slug** (its own `Slug` column). Steady state = one `slackLists.items.list` read + zero writes (cells only written when a value actually drifted).
- **List handle is cached** on `workspaces.slack_roadmap_list` (jsonb) as `{ id: "F…", cols: { <schema key>: <generated column id> } }`. The List is created once per workspace by the bot (`slackLists.create`); Slack returns a generated column id per schema key, which we must address cells by — so we cache the key→id map. Null = "not yet created"; the next sync creates it and backfills the handle.
- **Cell encoding** (via [[slack]] `slackListCell`): `text` columns are written/read as Block Kit `rich_text`; `number` columns as a 1-element array. Reads pull `field.text` (text) / `field.value` (number).
- **Schema** (column order): `Spec` (primary text = title) · `Status` (text, e.g. "🚧 In progress") · `Owner` (text = `functionLabel(owner)`) · `Phases` (number = phase count) · `Slug` (text = diff key).

## Wiring

Called best-effort (awaited, but guarded) right after the Home view is (re)published, so the List tracks the same board:
- **On Home open** — `publishHomeForUser` in `src/app/api/slack/events/route.ts` (`app_home_opened`).
- **After a queued build** — `handleHomeBuild` in `src/app/api/slack/interactions/route.ts` (board state changed).

## Slack-app config (one-time, owner)

The bot needs scopes **`lists:read`** + **`lists:write`** (App config → OAuth & Permissions → reinstall). Without them, `slackLists.create`/`list` fail and sync no-ops — the Home tab is unaffected. The bot-created List is owned by the app; the owner shares it to themselves / a channel in Slack to view it (it does not need to be shared for the mirror to keep syncing).

## Conventions

- **Brain stays source of truth** — Slack mirrors it, never the reverse ([[../operational-rules]] North star: a bounded mirror, not a proxy that can drift).
- Never blocks the Home view: a Lists API outage degrades to a stale List, not a broken Home tab.

## Callers

- `src/app/api/slack/events/route.ts` · `src/app/api/slack/interactions/route.ts`

## Related

[[slack]] · [[slack-home]] · [[slack-roadmap]] · [[brain-roadmap]] · [[../integrations/slack-roadmap-console]] · [[../tables/workspaces]] · [[../specs/slack-roadmap-home]]

---

[[../README]] · [[../../CLAUDE]]
