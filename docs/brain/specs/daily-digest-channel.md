# Daily digest — one Slack post/day to #daily-digest ⏳

**Owner:** [[../functions/platform]] · **Parent:** the Slack-cleanup pass (2026-06-23) — replace per-event FYI pings with **one** daily summary.

**Why:** the owner was flooded by Slack. The build/roadmap flood was moved to the Agents hub; critical ops + customer/fraud events stay in their channels. What's left — **FYI-grade** signals (dunning summaries, notable ad-performance shifts, non-critical ops warnings, the day's build/ship activity) — should NOT ping per-event. Roll them into **one post per day** to **`#daily-digest`** (channel `C0BCQ1ZNJ1F`).

## What it posts (once/day)
A single Slack message to `#daily-digest`:
- **Build/ship recap** (from [[../tables/director_activity]] + `agent_jobs` for the day): specs shipped · goals advanced · bugs fixed · approvals auto-handled · escalations. (The directors' EOD standup — same source as the Agents-hub Daily Summaries tab; this is its Slack mirror.)
- **Money/retention FYIs:** dunning — recoveries + still-failing count (from the dunning data); notable ad-performance shifts (Meta — only material deltas).
- **Platform FYIs:** count of non-critical ops warnings (the ones that no longer DM), DB-health/coverage proposals waiting in the Agents hub.
- A link to the Agents hub for the detail. Concise — a scannable digest, not a wall.

## Phase 1 — the daily-digest cron ⏳
A new Inngest daily cron (`daily-digest-cron`, e.g. `0 13 * * *`), registered in `MONITORED_LOOPS` ([[coverage-auto-register-agent]]); aggregates the day's `director_activity` + dunning + ad-perf + ops-warning counts into one Slack post to `#daily-digest` (`C0BCQ1ZNJ1F`) via [[../libraries/slack]] `postMessage`. Gated on a Slack token; no-op if absent. Brain: [[../inngest/daily-digest-cron]] · [[../tables/director_activity]] · [[../libraries/slack]] · [[devops-director]].

## Verification
- Run the cron once → **exactly one** message lands in `#daily-digest` summarizing the day (build recap + dunning + ad-perf + ops-warning counts), with an Agents-hub link; no per-event spam.
- A day with no activity → a brief "quiet day" digest (or skip), never an error.
- The cron is registered in `MONITORED_LOOPS` (no unregistered-loop gap on the Control Tower).
- Negative: critical ops alerts still go to `#alerts-critical` (not delayed into the digest); customer/fraud channels unchanged.
