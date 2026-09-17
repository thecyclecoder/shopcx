# inngest/portal-auto-resume

Resumes paused subs at `pause_resume_at` using the shared internal-aware subscription action path. Used by cancel-flow pause remedies + crisis Tier 3.

**File:** `src/lib/inngest/portal-auto-resume.ts`

## Implementation

Resume goes through [[../libraries/commerce__subscription]]'s `subscriptionAction(..., "resume")`,
which is **engine-aware**: an `internal` sub is marked active locally without touching any vendor, a
`shopcx` sub resumes its Shopify contract, and an `appstle` sub goes to the Appstle API. This is why
internal contract ids (UUIDs Appstle would reject) never leave the box. Helper `appstleResume` — the
name is historical — wraps it and throws on error so failures stay visible in cron logs.

## ⭐ A resumed sub must be given a date it can bill on

Resuming only flips `status` back to `active`. **Nothing was setting a new billing date**, so after a
30/60/90-day pause the row still carried the date it had when it was paused — now in the past. On
`internal` that means an immediate surprise charge. On `shopcx` it is worse: the renewal worker
resolves which Shopify cycle to bill BY DATE and skips a cycle already marked `BILLED`, so a stale
date lands in a spent cycle and the subscription is **never charged again, silently**.

`retimeAfterResume()` fixes both paths, on the cron and the event function alike:

- rolls forward from the sub's ORIGINAL date by its own cadence (`rollForwardToFutureBillingDate`),
  so a customer who billed on the 12th still bills on the 12th — the pause skips some of their days,
  it does not move them. Tomorrow is the floor if the roll cannot produce a future date.
- on `shopcx`, calls `shopifyRetimeContract` so the **Shopify cycle schedule** moves too — setting
  `nextBillingDate` alone only moves a display field
  ([[../libraries/commerce__shopify-subscription-client]] § "Keeping a customer's own dates").
- if the new date still lands in a spent cycle, `shopifyRetimeContract` returns `stranded` and this
  logs it loudly rather than succeeding quietly into a sub that will never bill.

The resulting date is written to `subscriptions.next_billing_date` in the same update that clears
`pause_resume_at`.

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
