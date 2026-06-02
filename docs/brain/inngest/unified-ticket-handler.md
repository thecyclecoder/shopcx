# inngest/unified-ticket-handler

**THE main pipeline.** Every inbound message: resolve → playbook check → Sonnet orchestrator → execute decision. Touches almost every table. See [[../lifecycles/ticket-lifecycle]].

**File:** `src/lib/inngest/unified-ticket-handler.ts`

## Functions

### `unified-ticket-handler`
- **Trigger:** event `ticket/inbound-message`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.ticket_id" }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/customer_links]]
- [[../tables/customers]]
- [[../tables/dashboard_notifications]]
- [[../tables/escalation_gaps]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Tables read (not written)

- [[../tables/ai_channel_config]]
- [[../tables/ai_personalities]]
- [[../tables/journey_definitions]]
- [[../tables/macros]]
- [[../tables/orders]]
- [[../tables/playbooks]]
- [[../tables/workflows]]
- [[../tables/workspace_members]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
