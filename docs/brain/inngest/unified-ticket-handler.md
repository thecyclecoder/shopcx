# inngest/unified-ticket-handler

**THE main pipeline.** Every inbound message: resolve → playbook check → Sonnet orchestrator → execute decision. Touches almost every table. See [[../lifecycles/ticket-lifecycle]].

**File:** `src/lib/inngest/unified-ticket-handler.ts`

## Functions

### `unified-ticket-handler`
- **Trigger:** event `ticket/inbound-message`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.ticket_id" }]`

## Sentinel messages (`message_body`)

Some `ticket/inbound-message` events carry a synthetic `message_body` instead of real customer text. These are internal wake-ups for an **active playbook**, not customer messages:

| Sentinel | Fired by | Purpose |
|---|---|---|
| `playbook-apply` | `app/api/tickets/[id]/apply-playbook/route.ts` | An agent applied a playbook from the dashboard — run it now |
| `items_selected` | journey completion (item picker) | Resume the playbook waiting on the journey output |
| `address_confirmed` | journey completion (address form) | Same, for the shipping-address journey |

Two guards govern them:
- **§0a short-circuit:** if a sentinel arrives and there's **no** `active_playbook_id`, skip the orchestrator entirely (running Sonnet on the literal sentinel string just re-routes to the same journey — Lee Summers double-send bug).
- **Active-playbook block:** when a playbook IS active, the handler normally asks Haiku "is this message about the playbook or a new topic?". **Sentinels bypass that classifier and execute the playbook directly** — Haiku would see the literal string `"playbook-apply"`, call it NEW_TOPIC, and bounce to the orchestrator, so a freshly-applied playbook would never run (Ida McDonald 2026-06-10). See `isSentinel` at the `classify-playbook-msg` step.

Applying a playbook sets `active_playbook_id`, `playbook_step:0`, `status:closed`, inserts the agent-context as an internal message, then fires `playbook-apply`. The playbook then auto-identifies the order/subscription and runs through its steps (e.g. Refund → apply_policy → reply explaining ineligibility).


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
