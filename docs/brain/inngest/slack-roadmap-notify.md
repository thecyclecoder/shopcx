# inngest/slack-roadmap-notify

Status-push watcher for the [[../integrations/slack-roadmap-console|Slack Roadmap Console]] (Phase 5). Diffs `agent_jobs` against a marker column and posts build-status transitions into `#roadmap`. All Slack logic stays in the Vercel app — the box worker stays Slack-unaware.

**File:** `src/lib/inngest/slack-roadmap-notify.ts`

## Functions

### `slack-roadmap-notify`
- **Trigger:** cron `* * * * *` (every minute — cron's finest granularity; the spec's "~30 s" rounds to 1/min). **Retries:** 1.
- **For each Slack-connected workspace:** resolve the bot token, find the `#roadmap` channel by name (`findChannelByName`), then select recently-transitioned jobs and post the ones whose marker hasn't caught up.
- **Notify statuses:** `needs_input`, `needs_approval`, `completed`, `failed`, `needs_attention`. Message bodies come from `buildStatusPushMessage` ([[../libraries/slack-roadmap]]).
- **Dedup marker:** [[../tables/agent_jobs]]`.slack_notified_status`. Posts only when `status != slack_notified_status`; sets the marker **after** a successful post (a failed post leaves the marker so the next tick retries).
- **Cold-start flood guard:** only considers jobs with `updated_at` within the last **15 min**, capped at **25 per workspace per tick** — so the first run after the column was added doesn't replay every historical terminal job.

## Tables written

- [[../tables/agent_jobs]] (sets `slack_notified_status`)

## Tables read (not written)

- [[../tables/workspaces]] (Slack token + team), [[../tables/agent_jobs]]

## Gotchas

- The channel is resolved by **name** (`roadmap`) over the bot's channel list each tick — no stored channel id. Invite the bot to a private `#roadmap` channel or nothing posts.
- Reads `docs/brain/specs/*.md` (`getSpec`) for card titles — traced into the `/api/inngest` bundle in `next.config.ts`.

## Related

[[../integrations/slack-roadmap-console]] · [[../libraries/slack-roadmap]] · [[../libraries/slack]] · [[../tables/agent_jobs]] · [[../integrations/inngest]] · [[../lifecycles/roadmap-build-console]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
