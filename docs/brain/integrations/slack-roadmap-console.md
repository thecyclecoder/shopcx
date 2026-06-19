# integrations/slack-roadmap-console

The **inbound** Slack surface for the roadmap build console — run the [[../lifecycles/roadmap-build-console]] from the private `#roadmap` channel on a phone. A second front-end over the existing backend: Slack writes [[../tables/agent_jobs]] and calls the same owner-gated logic ([[../libraries/roadmap-actions]]) the dashboard buttons do. **No new build engine, no new approval logic, and the box is never contacted.**

Outbound Slack ([[../libraries/slack]], [[../libraries/slack-notify]]) already existed; this adds the first inbound endpoints.

## Endpoints (both HMAC-verified)

| Route | Handles |
|---|---|
| `POST /api/slack/events` | Slash commands `/roadmap`, `/build`, `/bug` + the Events API `url_verification` challenge |
| `POST /api/slack/interactions` | `block_actions` (button taps) + `view_submission` (answer modal) |

Both call `verifySlackSignature(rawBody, X-Slack-Signature, X-Slack-Request-Timestamp)` ([[../libraries/slack]]) — HMAC-SHA256 over `v0:{ts}:{body}` keyed by `SLACK_SIGNING_SECRET`, **rejecting timestamp skew > 5 min** (replay guard). Workspace is resolved from the Slack `team_id` (`resolveWorkspaceByTeamId`).

## Commands & actions

- **`/roadmap`** → board (Planned / In progress / Shipped — awaiting verification) with live build chips. **`/roadmap <slug>`** → single-spec detail. Read-only, no token spend.
- **`/build <slug> [instructions]`** → `queueRoadmapBuild` (one active build per spec; refusal surfaced as an ephemeral).
- **`/bug <slug> <desc>`** → fix-build (`instructions` scoped; spec stays ✅, no spec edit).
- **Buttons:** Build · View PR (URL) · Answer (opens modal → `view_submission` → `answerRoadmapBuild` → `queued_resume`) · Approve & apply / Decline (`approveRoadmapAction`) · Squash & merge (`mergeClaudePr`). After a mutation the handler `updateMessage`s the source message (single-purpose messages only — never the shared board).

## Identity & owner gate (twice)

1. **UX filter** — [[../libraries/slack-identity]] `resolveSlackActor(workspaceId, slackUserId)` maps the Slack user → ShopCX member; non-owner → "owner-only" ephemeral, nothing runs.
2. **Security boundary** — [[../libraries/roadmap-actions]] re-checks the owner gate server-side against the resolved `userId`, regardless of what the button payload claims. A spoofed/replayed button can't act.

## Status push

The [[../inngest/slack-roadmap-notify]] cron (Vercel, every minute) posts transitions into `needs_input` / `needs_approval` / `completed` / `failed` / `needs_attention` to `#roadmap`, deduped via [[../tables/agent_jobs]]`.slack_notified_status`. The channel is resolved by name (`roadmap`) — invite the bot there.

## Slack app config

- **Interactivity & Shortcuts** Request URL → `https://shopcx.ai/api/slack/interactions`
- **Event Subscriptions** Request URL → `https://shopcx.ai/api/slack/events` (answers `url_verification`)
- **Slash Commands** `/roadmap`, `/build`, `/bug` → `https://shopcx.ai/api/slack/events`
- **Env:** `SLACK_SIGNING_SECRET` (new) + the existing per-workspace bot token (encrypted on [[../tables/workspaces]]). Connection persisted by `src/app/api/slack/{callback,channels,disconnect,sync-members}/route.ts`.

## Safety / invariants

- Signature verification on **every** inbound request; unsigned/stale rejected (401).
- Owner gate server-side, **twice** (UX filter + revalidated action).
- **The box is never contacted** — Slack only writes `agent_jobs` / calls app routes; the worker polls outbound exactly as today.
- **Slack never runs prod actions** — migrations / prod scripts are still executed only by the worker after `approve`; Slack posts the preview and records the decision.
- PRs never auto-merge — merge is an explicit owner button → server-revalidated `mergeClaudePr`.

## Related

[[../lifecycles/roadmap-build-console]] · [[../libraries/slack]] · [[../libraries/slack-roadmap]] · [[../libraries/slack-identity]] · [[../libraries/roadmap-actions]] · [[../inngest/slack-roadmap-notify]] · [[../tables/agent_jobs]] · [[../dashboard/roadmap]] · [[../dashboard/branches]]

---

[[../README]] · [[../../CLAUDE]]
