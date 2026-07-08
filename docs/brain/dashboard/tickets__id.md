# dashboard/tickets/[id]

The ticket detail page — where agents work a single ticket. Three-column layout on desktop (conversation + tabs + customer/actions sidebar), collapses to a mobile section toggle on small screens.

**File:** `src/app/dashboard/tickets/[id]/page.tsx`

## Top-level layout

| Region | Mobile section | Desktop position |
|---|---|---|
| Conversation pane | `conversation` (default) | Center column |
| Tab strip | (always visible) | Top of center column |
| Customer / actions sidebar | `details`, `customer`, `subscriptions`, `orders`, `returns`, `replacements`, `chargebacks`, `fraud`, `loyalty`, `reviews`, `actions` | Right column, 320px |

Mobile dropdown at the top swaps the visible region (`conversation` ↔ any of the sidebar sections).

## Center-column tabs

Five tabs, persisted in component state (`activeTab`):

### Messages (default)
The conversation thread. Shows every `ticket_message` for the ticket in chronological order. Renders inbound from customer (left bubble), outbound from AI/agent/system (right bubble or system note). Reply composer at the bottom with rich-text formatting, channel-aware delivery (email / chat / social comment / Meta DM / SMS).

Includes: pending-send banner (when an outbound message is delayed via `pending_send_at`), AI draft preview (sandbox mode), inline action chips (Approve & Reply, etc.), journey-suggest cards.

### Timeline
Per-customer event timeline pulled from [[../tables/customer_events]] — every portal action, subscription mutation, journey response, dunning step, etc. Renders as a vertical list with timestamps and event types. Lets agents see what the customer has done across ALL tickets and self-serve actions, not just this one ticket. Lazy-loaded on first tab activation.

### History
Other tickets from this customer (and linked accounts). Surfaces patterns — "this customer has opened 5 tickets in 30 days" or "their last 3 tickets were all about Mixed Berry stock." Each row clickable to its own detail page. Lazy-loaded on first activation.

### Improve (owner / admin only)
Per-ticket AI / orchestrator debugging. Shows:
- The Sonnet decision JSON from [[../tables/ticket_analyses]]
- Knowledge gaps surfaced
- Manual heal triggers via [[../lifecycles/research-and-heal]] recipes (`verify_subscription_changes`, `verify_coupon_promises`, `verify_grandfathered_pricing`)
- Buttons to re-run the orchestrator with context (similar to social-comments regenerate)
- Pattern-match audit (which `smart_patterns` row matched, what the score was)
- Macro suggestion accept/reject log

This tab is the operator surface for tuning the AI on individual tickets. Use it after fixing a sonnet_prompt or adding a recipe to verify the change holds.

### API logs (owner / admin only)
Raw Appstle / Shopify / Braintree / etc. API call log scoped to this ticket. Shows the actual request / response for every external mutation fired during this ticket's lifetime. Used for debugging "the orchestrator said it skipped but Appstle says no" disputes.

## Right sidebar — collapsible sections

The sidebar renders multiple cards stacked vertically. Each is independently expandable on desktop; on mobile, the section dropdown jumps to one at a time.

| Section | Content |
|---|---|
| **Actions** | Reply / journey-send / playbook-trigger / heal / escalate / close / archive / merge buttons. Where agents take action without typing a reply. |
| **Details** | Ticket-level state: status, channel, assignee, escalation, tags, intent + confidence, AI turn count, journey/playbook state. |
| **Customer** | Name, email, phone, retention score, LTV, subscription status, marketing consent. Click → `/dashboard/customers/{uuid}`. |
| **Subscriptions** | Active + paused + cancelled subs across linked accounts. Each is clickable to the sub detail page. Pause / resume / cancel / skip actions inline. |
| **Orders** | Recent orders with status, total, ship-to. Each clickable. Reorder action. |
| **Returns** | Existing return rows for this customer with status (label_created / in_transit / delivered / refunded). Recipe to create a new one. |
| **Replacements** | The `replacements` table rows — free orders we shipped for goodwill / crisis / wrong-item. |
| **Chargebacks** | Open and historical Shopify disputes. Auto-cancel actions logged. |
| **Fraud** | Open fraud cases. Severity + rule + orders held. |
| **Loyalty** | Points balance, recent transactions, available redemption tiers. |
| **Reviews** | Klaviyo-synced product reviews from this customer. Featured flag + AI summary if computed. |

## Common agent flows on this page

- **Reply via Improve tab**: open Improve → click "Regenerate AI suggestion with context" → type a hint → review → Approve & Send. Same pattern as social-comments.
- **Issue replacement**: Actions section → "Create replacement" → pick variant + quantity → ships free. Backed by [[../recipes/issue-replacement]].
- **Heal**: Improve tab → if the AI flagged a verification gap, recipes from [[../lifecycles/research-and-heal]] surface here with manual-execute buttons.
- **Escalate**: Details section → "Escalated To" dropdown. The routine escalation surfaces as **💬 June** (CS Director) with her headshot — the ticket UI resolves the routine target to the [[../libraries/cs-director|CS Director]] persona (`PERSONAS['cs-director']` in `src/lib/agents/personas.ts`) via `resolveEscalationPersona` in `src/lib/ticket-escalation-persona.ts`, so the field shows the real reviewer (June — the third-rung hard-caller above the [[../specs/box-escalation-triage|escalation-triage]] quorum, per [[../specs/cs-director-third-rung-hard-calls-above-triage-quorum]]) rather than a generic "🤖 AI Routine" label. The identity block above the select renders `PersonaAvatar` from [[../libraries/agent-personas|agent-personas]] (the same org/roster renderer — June's `avatarUrl` = `agent-avatars/june-cs.jpg`) + her 💬 emoji + name + role. Selecting it still routes to the idle-triage routine (`escalated_at` set, `escalated_to = null`, via a `{ escalate_to_routine: true }` PATCH to `/api/tickets/[id]`), which the hourly cron picks up ([[../inngest/triage-escalations]]) — June's hard-call runs when quorum can't resolve it. Picking a specific person instead sets `escalated_to = their uuid` (human-owned; the routine skips it). "Not escalated" clears both. See [[../specs/escalate-to-routine-by-default]].
- **Unmerge / merge**: Actions → Merge into another ticket (drops to archived with `merged_into` set) or unarchive.

## Permissions

- **Improve tab + API logs tab**: owner / admin only.
- Other tabs + sidebar: any role that can see tickets (owner / admin / agent / social).
- Mutation buttons in sidebar respect role (e.g. only owner / admin can force-cancel a subscription on someone else's customer).

## Related

[[../lifecycles/ticket-lifecycle]] · [[../lifecycles/ai-multi-turn]] · [[../lifecycles/research-and-heal]] · [[../orchestrator-tools]] · [[../customer-voice]] · [[../tables/tickets]] · [[../tables/ticket_messages]] · [[../tables/ticket_analyses]] · [[../tables/customer_events]] · [[tickets]]
