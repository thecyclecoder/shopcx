# inngest/portal-auto-resume

Resumes paused subs at `pause_resume_at`. Used by cancel-flow pause remedies + crisis Tier 3.

**File:** `src/lib/inngest/portal-auto-resume.ts`

## Functions

### `portal-auto-resume-cron`
- **Trigger:** cron `15 * * * *`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`


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
