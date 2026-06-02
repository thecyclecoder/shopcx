# inngest/ticket-research

Research-and-heal pipeline: deep investigation → recipe match → propose heal → auto-execute allowlisted. Writes `ticket_research_runs`, `ticket_heal_attempts`. See [[../lifecycles/research-and-heal]].

**File:** `src/lib/inngest/ticket-research.ts`

## Functions

### `ticket-research-requested`
- **Trigger:** event `ticket/research.requested`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 8 }]`


### `ticket-heal-requested`
- **Trigger:** event `ticket/heal.requested`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 4 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/ticket_heal_attempts]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Tables read (not written)

- [[../tables/customers]]
- [[../tables/ticket_research_runs]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
