# inngest/portal-action-healer

Cron that triages **open "Portal action needs help" tickets** (tag `portal-action-failed`) and either re-runs the action, auto-dismisses it, or hands it to a human. All logic lives in [[../libraries/portal__remediation]]; this is just the scheduler shell.

**File:** `src/lib/inngest/portal-action-healer.ts`

## Functions

### `portal-action-healer`
- **Trigger:** `cron: "*/15 * * * *"` + event `portal/heal.tick` (manual kick)
- **Concurrency:** `[{ limit: 1 }]`
- **Loop:** every workspace → `fetchOpenPortalFailures` → `remediatePortalTicket` per ticket
- **Returns:** tally `{ healed, dismissed, escalated, retry_pending, skipped }`

## Outcomes

- **healed** — transient error cleared, action re-run, ticket closed
- **dismissed** — UI/validation error (insufficient points, last-line-item removal), closed + tagged `auto-dismissed`
- **retry_pending** — still transient, left open, retried next tick (max 3, then `needs-human`)
- **escalated / skipped** — `needs-human` tagged (unrecognized error or exhausted) or human already owns it

## Tables written

- [[../tables/tickets]] (status/tags/closed_at)
- [[../tables/ticket_messages]] (system notes)
- [[../tables/subscriptions]] (on a healed `changedate`)

## Tables read

- [[../tables/customer_events]] (`portal.error` — structured failure context)

## Gotchas

- **`needs-human` is terminal for the automation** — those tickets stay open but are skipped on every pass so the cron never re-hammers Appstle with a known-bad replay.
- Classification keys off the error **message**, not the HTTP status (the portal wraps all Appstle errors as 502). See [[../libraries/portal__remediation]].

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
