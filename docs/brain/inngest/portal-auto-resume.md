# inngest/portal-auto-resume

Resumes paused subs at `pause_resume_at`. Used by cancel-flow pause remedies + crisis Tier 3.

**File:** `src/lib/inngest/portal-auto-resume.ts`

## Functions

### `portal-auto-resume-cron`
- **Trigger:** cron `15 * * * *`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`
- **Control Tower heartbeat:** emits `emitCronHeartbeat("portal-auto-resume-cron", …)` at the end of *every* run — including the common no-work path (`subs.length === 0`), so the 2h `cron_freshness` assertion stays green during quiet hours. The beat means "Inngest invoked me", not "there was work" — honors the [[../libraries/control-tower]] heartbeat contract, same idle-tick fix as [[ticket-csat]] / [[marketing-text]] ([[../specs/cron-heartbeat-on-idle-tick]]).


### `portal-auto-resume`
- **Trigger:** event `portal/subscription-paused`
- **Retries:** 3


## Downstream events sent

_None._

## Tables written

- [[../tables/customer_events]]
- [[../tables/subscriptions]]

## Tables read (not written)

- [[../tables/workspaces]]

## Header notes

```
Inngest cron: auto-resume paused subscriptions when pause_resume_at has passed

Runs every hour, picks up all paused subs where pause_resume_at <= now()
This replaces the old sleep-based approach which died on deploys.

The event-triggered function is kept for backwards compat but is a no-op —
the cron handles everything.
```

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
