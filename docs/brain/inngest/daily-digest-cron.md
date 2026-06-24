# inngest/daily-digest-cron

The **one aggregated FYI post per day** to `#daily-digest` (`C0BCQ1ZNJ1F`) — the Slack mirror of the directors' EOD standup plus the money/retention/platform signals that no longer ping per-event. Built by the Slack-cleanup pass (2026-06-23, [[../specs/daily-digest-channel]]): build/roadmap transitions moved to the Agents hub, ops *warnings* stopped DMing everyone (only CRITICAL pages `#alerts-critical` via [[../libraries/notify-ops-alert]]), and the remaining FYI-grade noise rolls into this single daily post instead of per-event spam.

**File:** `src/lib/inngest/daily-digest-cron.ts`

## Functions

### `daily-digest-cron`
- **Trigger:** cron `0 13 * * *` (13:00 UTC daily). **Retries:** 1.
- **For each Slack-connected workspace** (`workspaces.slack_bot_token_encrypted is not null`): resolve the bot token (`getSlackToken`); **gated** — no usable token → no-op for that workspace. Aggregate the last **24h** (`aggregateDigest`), build ONE message (`buildDigestBlocks`), `postMessage` to `#daily-digest`.
- **Window:** rolling 24h (`now − 24h`), not a calendar day — "the day's" build/ship activity reads as the last 24h regardless of the run hour.
- **Quiet day:** when every section is empty it still posts a brief *"Quiet day — nothing notable"* digest — exactly one message, never an error.
- **Heartbeat:** end-of-run `emitCronHeartbeat("daily-digest-cron", …)` so a dead digest is visible on the [[../dashboard/control-tower|Control Tower]]. Registered in `MONITORED_LOOPS` ([[../libraries/control-tower]] `registry.ts`, owner `platform`, `livenessWindowMs` 26h, `registeredAt` first-tick grace).

## What it summarizes (last 24h, all reads best-effort → zero on failure)

- **🛠 Build & ship** — [[../tables/agent_jobs]] (`kind='build'`, windowed on `updated_at`: completed / failed) + [[../tables/director_activity]] (windowed on `created_at`: total actions, `authored_fix`/`fixed_bug` → fixes, `escalated` → escalations). The directors' EOD standup, Slack-mirrored.
- **💸 Money & retention** — dunning from [[../tables/dunning_cycles]] (`recovered` in window · currently `retrying` · `exhausted` in window); notable Meta ad-perf shifts from [[../tables/daily_meta_ad_spend]] — the latest two snapshot days rolled up across accounts, surfaced **only** on a material delta (spend swing ≥25% **and** ≥$50, **or** ROAS swing ≥0.5).
- **🩺 Platform** — non-critical ops-warning count ([[../tables/error_events]] touched in window — the warnings that no longer DM) + items awaiting approval ([[../tables/agent_jobs]] `status='needs_approval'`).
- A context link to the Agents hub (`https://shopcx.ai/dashboard/agents`) for the detail.

## Tables read (no writes except the heartbeat)

- [[../tables/workspaces]] (Slack token gate) · [[../tables/agent_jobs]] · [[../tables/director_activity]] · [[../tables/dunning_cycles]] · [[../tables/daily_meta_ad_spend]] · [[../tables/error_events]]
- Writes only [[../tables/loop_heartbeats]] (via `emitCronHeartbeat`).

## Gotchas

- **Posts to a fixed channel id** (`C0BCQ1ZNJ1F`), not resolved by name — no bot-channel-list lookup. The bot must be a member of `#daily-digest`.
- **Critical ops alerts are unaffected** — they still page `#alerts-critical` in real time via [[../libraries/notify-ops-alert]]; they are never delayed into this digest. Customer/fraud channels unchanged.
- **`daily_meta_ad_spend.spend_cents` / `purchase_value_cents` are dollars ×100.** The digest divides by 100 and ROAS is derived locally (`rev/spend`).
- Each section is independent + best-effort: a failed query leaves that field at its zero rather than failing the post (the spec's "never an error" rule).

## Related

[[../specs/daily-digest-channel]] · [[../libraries/slack]] · [[../tables/director_activity]] · [[../libraries/notify-ops-alert]] · [[../goals/devops-director]] · [[../integrations/inngest]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
