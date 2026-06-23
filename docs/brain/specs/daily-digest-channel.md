# Daily digest — one Slack post/day to #daily-digest ✅

**Owner:** [[../functions/platform]] · **Parent:** the Slack-cleanup pass (2026-06-23) — replace per-event FYI pings with **one** daily summary.

**Why:** the owner was flooded by Slack. The build/roadmap flood was moved to the Agents hub; critical ops + customer/fraud events stay in their channels. What's left — **FYI-grade** signals (dunning summaries, notable ad-performance shifts, non-critical ops warnings, the day's build/ship activity) — should NOT ping per-event. Roll them into **one post per day** to **`#daily-digest`** (channel `C0BCQ1ZNJ1F`).

## What it posts (once/day)
A single Slack message to `#daily-digest`:
- **Build/ship recap** (from [[../tables/director_activity]] + `agent_jobs` for the day): specs shipped · goals advanced · bugs fixed · approvals auto-handled · escalations. (The directors' EOD standup — same source as the Agents-hub Daily Summaries tab; this is its Slack mirror.)
- **Money/retention FYIs:** dunning — recoveries + still-failing count (from the dunning data); notable ad-performance shifts (Meta — only material deltas).
- **Platform FYIs:** count of non-critical ops warnings (the ones that no longer DM), DB-health/coverage proposals waiting in the Agents hub.
- A link to the Agents hub for the detail. Concise — a scannable digest, not a wall.

## Phase 1 — the daily-digest cron ✅
A new Inngest daily cron (`daily-digest-cron`, `0 13 * * *`), registered in `MONITORED_LOOPS` ([[coverage-auto-register-agent]]); aggregates the last 24h of `director_activity` + `agent_jobs` (build/ship recap) + dunning + notable Meta ad-perf shifts + ops-warning counts into one Slack post to `#daily-digest` (`C0BCQ1ZNJ1F`) via [[../libraries/slack]] `postMessage`. Gated on a Slack token; no-op if absent. A quiet day still posts one brief "quiet day" digest. Brain: [[../inngest/daily-digest-cron]] · [[../tables/director_activity]] · [[../libraries/slack]] · [[devops-director]].

**Shipped:** `src/lib/inngest/daily-digest-cron.ts` (registered in `registered-functions.ts` + `MONITORED_LOOPS` in `control-tower/registry.ts`, owner `platform`). Aggregation is per-section best-effort (a failed read leaves that field at zero, never fails the post). Ad-perf surfaces only material deltas (spend swing ≥25% AND ≥$50, or ROAS swing ≥0.5). Brain page: [[../inngest/daily-digest-cron]].

## Verification
- In the Inngest dev/cloud dashboard, manually invoke `daily-digest-cron` (or wait for the 13:00 UTC tick) → expect **exactly one** message in `#daily-digest` (`C0BCQ1ZNJ1F`) with a `📊 Daily digest — YYYY-MM-DD` header, the present sections (🛠 Build & ship · 💸 Money & retention · 🩺 Platform) and an "Open the Agents hub →" context link; no per-event spam.
- On a workspace with **no Slack token** (`workspaces.slack_bot_token_encrypted` null) → expect the run completes with `posted:0`, no error, no message (gated no-op).
- On a 24h window with zero build/dunning/ad/ops activity → expect a single message reading *"Quiet day — nothing notable to report. 🌙"* with the hub link — never an error.
- On the [[../dashboard/control-tower|Control Tower]], confirm a **Daily digest** tile (owner Platform) exists and shows a fresh beat after the run → expect no "unregistered loop" gap and a green/amber-awaiting-first-run tile (registered in `MONITORED_LOOPS`).
- Negative — trigger a CRITICAL ops alert (`notifyOpsAlert` severity `critical`) → expect it pages `#alerts-critical` in real time, **not** delayed into the digest; the digest's ops-warning count covers only non-critical `error_events`. Customer/fraud channels unchanged.
- In the run output `produced` JSON → expect `{ workspaces, posted, skipped, since, dateLabel }` with `posted + skipped === workspaces`.
