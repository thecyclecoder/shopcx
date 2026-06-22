# Serve (or retire) the unserved crons — deliver-pending-sends + marketing-text-campaign-send-tick ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[control-tower-complete-coverage]] (the never-fired check caught this). · **Blocked-by:** [[control-tower-monitor-accuracy]] (so the verification reads true once false-positives clear).

The Control Tower's never-fired check flagged **`deliver-pending-sends`** and **`marketing-text-campaign-send-tick`** with **0 heartbeats ever**. The spec's original hypothesis was that neither was imported into the Inngest serve route — i.e. an in-code-vs-Inngest-registered gap.

## Resolution — both should run; both are already served (no code change)
Investigation (git archaeology + reading the serve list) shows the original root-cause hypothesis was **wrong**. Both crons are, and have always been, served and monitored:

- **`deliver-pending-sends`** — in the serve array since `2a56c9dc` (the function's first commit), registered as a monitored cron tile (`src/lib/control-tower/registry.ts`, `livenessWindowMs: 10m`), and heartbeat-wired (`emitCronHeartbeat` at the end of each run).
- **`marketing-text-campaign-send-tick`** — in the serve array since `8c2dfbcd` (Text marketing v1), registered as a monitored cron tile (same registry, `livenessWindowMs: 10m`), and heartbeat-wired.

Both now flow through the extracted `src/lib/inngest/registered-functions.ts` (which `src/app/api/inngest/route.ts` spreads verbatim) — `deliverPendingSends`, `textCampaignScheduled`, `textCampaignSendTick` are all present.

**Decision per cron: both should run.** Each is an active core path with no superseding duplicate:
- `deliver-pending-sends` drains the delay-then-send queue for outbound ticket messages (per-channel: email/chat/portal/other) — the mechanism behind "reply shows in UI immediately, ships after a delay." No other path delivers these.
- `marketing-text-campaign-send-tick` drains scheduled SMS campaign recipients to Twilio (SendAt window + immediate). The wave-promote / scheduled functions only *stage* recipients; this tick is the only sender. No duplicate.

So neither is retired and the `INTENTIONALLY_UNMONITORED_CRONS` allow-list is untouched (stays empty).

**Why the never-fired flag fired anyway:** `emitCronHeartbeat` itself didn't exist until `#185` (control-tower-complete-coverage). The two crons ran for months *without* emitting heartbeats simply because the heartbeat primitive wasn't written yet — so the registry's never-fired check, reading a beat table that was empty for them, reported "0 beats ever." That is precisely the false-positive class [[control-tower-monitor-accuracy]] (the blocker) was built to age out: once each cron runs once with the post-`#185` heartbeat code, it beats within its cadence and the tile goes green. No serve-route or registry change closes this — only a run with the new code.

## Verification
- In `src/lib/inngest/registered-functions.ts`, grep the `registeredInngestFunctions` array → expect `deliverPendingSends`, `textCampaignScheduled`, and `textCampaignSendTick` all present (the route at `src/app/api/inngest/route.ts` spreads this array verbatim).
- In `src/lib/control-tower/registry.ts` `MONITORED_LOOPS`, grep for `deliver-pending-sends` and `marketing-text-campaign-send-tick` → expect one `kind: "cron"` tile each, `livenessWindowMs: 10 * MIN`.
- In both `src/lib/inngest/deliver-pending-send.ts` and `src/lib/inngest/marketing-text.ts`, confirm the `emit-heartbeat` step calls `emitCronHeartbeat("<id>", …)` with the matching id at the end of the run.
- `INTENTIONALLY_UNMONITORED_CRONS` in `registry.ts` stays `{}` (neither cron is retired/exempted).
- On `/dashboard/developer/control-tower`, after the next scheduled run of each (≤1 min cadence + the 10-min liveness window), expect both tiles **green** (a recent heartbeat) and **neither** in the never-fired set.
- The self-audit's CODE↔REGISTRY diff (`auditCronCoverage()`) reports **0** unregistered-loop tiles for these two (both registered).

## Phase 1 — serve-or-retire decision + wiring ✅
Investigated both crons' intent + current coverage. Decision: **both should run** — and both were already served, registered, and heartbeat-wired (no code change required; the never-fired flag was the heartbeat-primitive-didn't-exist-yet false positive the blocker spec clears). Brain: [[../inngest/deliver-pending-send]] · [[../inngest/marketing-text]] · [[control-tower-complete-coverage]] · [[control-tower]].
