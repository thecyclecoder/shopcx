# Slack Roadmap Console — run the build console from Slack ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

A second front-end over the [[../lifecycles/roadmap-build-console]] backend, living in the private `#roadmap` Slack channel. View the roadmap board, commission builds, answer build questions, approve gated prod actions (migrations / prod scripts), squash-merge PRs, and report bugs — all from Slack, on a phone, without opening the dashboard. No new build engine and no new approval logic: Slack writes to `agent_jobs` and calls the existing `/api/roadmap/*` + `/api/branches/*` routes exactly as the dashboard buttons do; the tailnet-only box worker ([[../recipes/build-box-setup]]) polls and executes unchanged. A Vercel watcher pushes status transitions back to `#roadmap`.

**Business outcome:** Dylan stands up, unblocks, and ships work from the one app he already lives in — zero context-switch to the dashboard for the common build loop.

> **🔒 Reuse, don't rebuild:** Build / merge / approve are **owner-only and server-revalidated**. Slack buttons are untrusted input — every action re-checks the owner gate server-side regardless of who clicked. The box is never contacted; Slack only writes the queue the box already polls.

## What already exists (reuse)

- **Outbound Slack** ([[../libraries/slack]], `src/lib/slack.ts`) — `getSlackToken(workspaceId)`, `postMessage(token, channel, blocks, text)`, `lookupUserByEmail(token, email)`, `autoMapTeamMembers(workspaceId)`, Block Kit builders. **Outbound-only today — no inbound endpoint exists.**
- **Roadmap APIs** — `POST /api/roadmap/{build,answer,approve,chat}`, `GET /api/roadmap/build?slug=`, `GET/POST /api/roadmap/status`; `src/lib/brain-roadmap.ts` (`getRoadmap`, `getArchive`); `src/lib/agent-jobs.ts` (`getLatestJobsBySlug`, `getPendingFolds`).
- **Merge** — `POST /api/branches/[number]/merge` (owner-gated, server-revalidated) ([[../dashboard/branches]]).
- **Queue** — [[../tables/agent_jobs]]: statuses `queued → building → completed | needs_input | needs_approval → queued_resume`; `questions`/`answers`/`pending_actions` jsonb; one active build per spec.
- **Slack connection storage** — `src/app/api/slack/{callback,channels,disconnect,sync-members}/route.ts` already persist a per-workspace bot token + team mapping.

---

## Phase 1 — Slack inbound (signature-verified) ⏳

The one genuinely new piece: an inbound surface. Today `slack.ts` only posts.

- ⏳ `src/app/api/slack/events/route.ts` — POST handler for the Events API + slash commands. Verify the `X-Slack-Signature` / `X-Slack-Request-Timestamp` HMAC against `SLACK_SIGNING_SECRET` (reject if timestamp skew > 5 min). Handle the `url_verification` challenge.
- ⏳ `src/app/api/slack/interactions/route.ts` — POST handler for `block_actions` (button clicks) + `view_submission` (modal answer/spec forms). Same signature verification. Ack within 3 s, do work async.
- ⏳ `src/lib/slack.ts` — add `verifySlackSignature(rawBody, signature, timestamp)`, `openModal(token, triggerId, view)`, `postEphemeral(token, channel, user, blocks, text)`, `updateMessage(token, channel, ts, blocks, text)`.
- ⏳ Resolve the workspace from the Slack `team_id` (reverse-lookup over the saved Slack connection).
- ⏳ `SLACK_SIGNING_SECRET` added to env + Slack app config (Interactivity + Events Request URLs → these two routes).

## Phase 2 — Identity → owner gate ⏳

- ⏳ `src/lib/slack-identity.ts` — `resolveSlackActor(workspaceId, slackUserId)`: map Slack user → ShopCX `workspace_members` row via the saved team mapping (`autoMapTeamMembers` / `lookupUserByEmail` bridge). Returns `{ userId, role } | null`.
- ⏳ All mutating handlers (build, merge, approve, answer) resolve the actor first; non-owner → `postEphemeral` "owner-only" and stop. **The called `/api/roadmap/*` + `/api/branches/*` routes still enforce their own owner gate** — Slack identity is a UX filter, not the security boundary.
- ⏳ Calls into existing routes execute server-side as the resolved owner (internal service call carrying the workspace + owner user id), never trusting the button payload's claimed identity.

## Phase 3 — Read surface: `/roadmap` board ⏳

- ⏳ Slash command `/roadmap` → `getRoadmap(workspaceId)` → Block Kit message: **Planned / In progress / Shipped — awaiting verification** sections, each card = a spec with its live `agent_jobs` chip (`getLatestJobsBySlug`) and a status emoji. Pending-fold specs show "Folding…" (`getPendingFolds`).
- ⏳ Each card carries a context overflow / buttons: **Build**, **View PR** (if `pr_url`), **Squash & merge** (if `completed` + PR un-drafted). Cards with `needs_input` / `needs_approval` show a ⚠️ chip linking to the open prompt.
- ⏳ `/roadmap <slug>` → single-spec detail (phases + current build state + buttons).
- ⏳ Render is read-only and costs no tokens (pure DB + brain-markdown parse).

## Phase 4 — Action buttons → existing APIs ⏳

Each maps 1:1 to a dashboard action; all owner-gated (Phase 2) + server-revalidated.

- ⏳ **Build** button / `/build <slug> [instructions]` → `POST /api/roadmap/build` (inserts `queued` `agent_jobs`; refuses if an active build exists for the slug — surface that as an ephemeral notice).
- ⏳ **Report bug** — message action or `/bug <slug> <desc>` → `POST /api/roadmap/build` with `instructions` scoped as a fix-build (spec stays ✅, no spec edit).
- ⏳ **Answer questions** — when a job is `needs_input`, the pushed message (Phase 5) has an **Answer** button → `openModal` rendering `agent_jobs.questions` as inputs → `view_submission` → `POST /api/roadmap/answer` → `queued_resume`. Zero token cost.
- ⏳ **Approve & apply / Decline** — for `needs_approval`, render each `pending_actions` item (`apply_migration` / `run_prod_script` / `merge_pr`) with its `cmd`/`preview` in a code block + per-action buttons → `POST /api/roadmap/approve` `{jobId, actionId, decision}`. The worker (which holds prod creds) executes; Slack never runs SQL or prod commands.
- ⏳ **Squash & merge** — on a `completed` card → `POST /api/branches/[number]/merge` (resolve `pr_number` from the job row).
- ⏳ After each action, `updateMessage` to reflect the new state (button disabled / chip updated) so the channel stays a live to-do list.

## Phase 5 — Status push (Vercel watcher) ⏳

The **Vercel app** watches `agent_jobs` and posts to `#roadmap` (all Slack logic stays in the app; the box stays Slack-unaware).

- ⏳ Inngest function `inngest/slack-roadmap-notify` — cron (every ~30 s) that diffs `agent_jobs` for the workspace against a `slack_notified_status` marker and posts on transitions into `needs_input`, `needs_approval`, `completed`, `failed`, `needs_attention`. (Cron over Realtime = simplest; latency is fine, matches the existing board poll model.)
- ⏳ Marker: add `slack_notified_status text` to `agent_jobs` (the watcher only posts when `status != slack_notified_status`, then sets it). Migration via the `write-migration` skill.
- ⏳ Messages: `needs_input` → questions + **Answer** button; `needs_approval` → pending actions + **Approve & apply / Decline**; `completed` → PR link + **Squash & merge**; `failed`/`needs_attention` → `error` + `log_tail` tail. All to `#roadmap` (single channel — no per-spec threads in v1).
- ⏳ Reuse `getSlackToken` + `postMessage`; channel id resolved from the saved Slack connection (the `#roadmap` channel the bot was invited to).

## Deferred (not v1)

- Spec authoring (`/api/roadmap/chat`, Opus) from Slack — link out to the web authoring chat instead.
- Per-spec threads / channel fan-out (single `#roadmap` for now).
- Push via Supabase Realtime (cron is the v1 watcher).

## Safety / invariants

- **Owner gate is server-side, twice:** Slack identity filters UX (Phase 2); the underlying `/api/roadmap/*` + `/api/branches/*` routes independently enforce owner + re-validate. A spoofed/replayed button can't act.
- **Signature verification on every inbound request** (HMAC + ≤5 min timestamp); unsigned/stale requests rejected.
- **The box is never contacted.** Slack only writes `agent_jobs` / calls app routes; the worker polls outbound exactly as today. No inbound path to the tailnet box is introduced.
- **Slack never runs prod actions.** Migrations / prod scripts are still executed only by the worker after `approve`; Slack posts the preview and records the decision.
- **One active build per spec** preserved (enforced by `/api/roadmap/build`); Slack surfaces the refusal as an ephemeral message.
- **PRs never auto-merge** — merge is an explicit owner button → existing server-revalidated merge route.
- **No token spend from Slack** — board render, answers, approvals are pure DB/markdown; only the resumed build costs Max.

## Completion criteria

- `/roadmap` in `#roadmap` renders Planned / In progress / Shipped from the brain + live build chips.
- A non-owner tapping Build/Merge/Approve gets an owner-only ephemeral and nothing executes.
- **Build** (button or `/build <slug>`) inserts a `queued` `agent_jobs` row; the box picks it up and opens a `claude/*` PR.
- A build that hits `needs_input` posts to `#roadmap`; answering via the modal resumes the same session and the build finishes.
- A build that hits `needs_approval` posts the migration/script preview; **Approve & apply** runs it via the worker and resumes.
- **Squash & merge** on a `completed` card merges the PR; the message updates to merged.
- `/bug <slug> <desc>` queues a fix-build with the spec staying ✅.
- Signature verification rejects an unsigned/replayed request.

## Related

[[../lifecycles/roadmap-build-console]] · [[../specs/roadmap-build-console]] · [[../specs/build-approval-gates]] · [[../libraries/slack]] · [[../libraries/slack-notify]] · [[../tables/agent_jobs]] · [[../dashboard/roadmap]] · [[../dashboard/branches]] · [[../integrations/inngest]] · [[../project-management]]