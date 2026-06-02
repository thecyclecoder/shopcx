# inngest/ai-nightly-analysis

Nightly review of recent AI-handled tickets. Writes `daily_analysis_reports`. Paused 2026-04-28.

**File:** `src/lib/inngest/ai-nightly-analysis.ts`

## Functions

### `ai-nightly-analysis`
- **Trigger:** _unknown_
- **Retries:** 1


## Downstream events sent

_None._

## Tables written

- [[../tables/dashboard_notifications]]

## Tables read (not written)

- [[../tables/ai_channel_config]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Header notes

```
DEPRECATED 2026-05-06: replaced by ticket-analysis-cron.ts which
grades each closed AI ticket within 30 minutes of close. The nightly
batch is kept as a no-op for now to avoid disturbing existing
notification archives, but the cron is disabled and the function
returns immediately. Once the new system is validated for ~1 week,
this file + the route registration can be removed entirely.

Old behavior: Analyzed all AI-handled tickets from the past 24 hours
in one batch, scored accuracy, etc.
New behavior: see src/lib/ticket-analyzer.ts + ticket-analysis-cron.ts
```

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
