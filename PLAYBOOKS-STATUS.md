# Playbook System — Build Status

## What's Done

### Database ✅
- `playbooks` table — name, trigger_intents, trigger_patterns, priority, exception_limit, stand_firm_max
- `playbook_policies` table — conditions, ai_talking_points
- `playbook_exceptions` table — tiered, conditions, resolution_type, auto_grant
- `playbook_steps` table — ordered steps with type, instructions, data_access, config
- `escalation_gaps` table — logged when nothing matches
- Ticket fields: `active_playbook_id`, `playbook_step`, `playbook_queue`, `playbook_context`, `playbook_exceptions_used`
- Default playbooks seeded: "Unwanted Charge" (8 steps) + "Missing Order" (4 steps)

### Executor ✅ (`src/lib/playbook-executor.ts`)
- Step-by-step execution engine
- Handlers for: identify_order, identify_subscription, check_other_subscriptions, apply_policy, offer_exception, initiate_return, cancel_subscription, issue_store_credit, stand_firm, explain, custom
- Condition evaluator (order conditions + customer conditions with OR support)
- Multi-order handling (evaluates all orders against policy, exception limit per execution)
- Linked customer profile support (combined LTV, orders, subscriptions)
- Timeline-aware (compares customer_events vs ticket timestamps)
- AI response generation via Haiku for each step

### Unified Handler Integration ✅ (`src/lib/inngest/unified-ticket-handler.ts`)
- Step 3b: Active playbook detection (before positive close)
- Route priority 2: playbooks between journeys and workflows
- `matchPlaybook()` checks trigger_intents and trigger_patterns
- First step executes immediately on match
- Playbook queue: auto-starts next queued playbook on completion
- API failure → Slack notification
- `handlerNames()` includes playbook intents for AI classification

### Settings UI ✅ (`src/app/dashboard/settings/playbooks/page.tsx`)
- List view with expandable detail for each playbook
- Shows triggers (intents + patterns), policies, exceptions (tiered with auto-grant), steps with icons
- Active toggle per playbook
- API: CRUD at `/api/workspaces/[id]/playbooks`
- Settings card added to "Ticketing & AI" section

### Spec ✅ (`PLAYBOOK-SPEC.md`)
- Full data model documented
- Execution flow with all pitfall mitigations
- Return flow integration design
- Simulate with AI feature spec
- Default playbooks detailed

## What Needs to Be Built

### 1. Settings UI — Edit Mode
Currently read-only (can toggle active, view details). Needs:
- Edit playbook name, description, triggers
- Add/edit/delete steps (drag to reorder)
- Add/edit/delete policies
- Add/edit/delete exceptions (condition builder)
- Priority reordering (drag)

### 2. Simulate with AI
- Pick a customer from dropdown
- Enter sample message
- Sonnet walks through each step showing what AI would do
- Warnings about missing scenarios

### 3. Shopify Returns Integration
- `returnCreate` GraphQL mutation
- Return tracking (ask customer for tracking number)
- Auto-issue store credit/refund when return received
- Returns dashboard page (sidebar item below Orders)
- Shopify webhooks: `returns/create`, `returns/update`

### 4. Playbook Step: initiate_return
Currently logs intent but doesn't create a Shopify return. Needs actual Shopify Returns API integration.

### 5. Auto-grant Exception Detection
`checkAutoGrant()` currently returns false for all triggers. Needs:
- `duplicate_charge`: detect from order/billing data
- `cancelled_but_charged`: compare sub cancellation date vs order date
- `never_delivered`: check fulfillment/tracking status

### 6. Playbook Queue — Customer Context Acknowledgment
After one playbook completes and the next starts, AI should acknowledge: "Now about your other concern..."
(Memory: `feedback_acknowledge_journey_completion.md`)

### 7. Agent-Facing Playbook Guide
When agent opens a ticket with an active playbook, show the playbook steps in the sidebar as a checklist/guide.

## Key Design Decisions (from discussion)

1. **Step tracking** — current step on ticket, AI stays on it, can skip ahead if confident
2. **Multiple playbooks** — priority ordering, queue on ticket, second playbook checks preconditions
3. **Tangents** — KB/macro answers inline, steer back to current step. New issues get queued
4. **Conditions** — admin's responsibility to write good OR/AND conditions. AI follows strictly
5. **Partial info** — retry within same step, no limit on retries within a step
6. **Multi-order** — evaluate all against policy, exception limit per execution (configurable)
7. **Stale data** — re-fetch every step, acknowledge timeline changes
8. **API failures** — only escalation trigger. Pre-check eligibility. Slack notification
9. **Stand firm** — max repetitions (3), then final offer, ticket to pending
10. **No human escalation needed** — AI handles the full playbook including stand firm
11. **Returns require real return** — customer pays shipping, no refund without return (except system errors)

## Key Files
- `src/lib/playbook-executor.ts` — execution engine
- `src/lib/inngest/unified-ticket-handler.ts` — integration (search for "playbook")
- `src/app/api/workspaces/[id]/playbooks/route.ts` — CRUD API
- `src/app/dashboard/settings/playbooks/page.tsx` — settings UI
- `supabase/migrations/20260403300000_playbook_system.sql` — schema
- `supabase/migrations/20260403310000_seed_default_playbooks.sql` — defaults
- `PLAYBOOK-SPEC.md` — full spec with pitfall mitigations
