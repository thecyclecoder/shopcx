# Missing Items Checklist

When a customer says their order arrived but something's missing, this journey shows them their actual line items and lets them check off the ones that didn't arrive. The result drives a partial replacement order via the [[../playbooks/replacement-order]] playbook.

DB row in [[../tables/journey_definitions]]: `slug='missing-items'`, `journey_type='custom'`, `trigger_intent=null`.

## Trigger

- **trigger_intent**: null — not auto-triggered.
- **match_patterns**: empty.
- **priority**: 50

Triggered by the [[../playbooks/replacement-order]] playbook as a step within its flow, not by direct customer message matching. The orchestrator picks the playbook; the playbook launches this journey to collect the missing-item list.

## Channels

`email`, `chat`, `sms`. (Not `social_comments`, not `meta_dm`.)

## Steps

Built by `src/lib/missing-items-journey-builder.ts`:

1. **Identify the order** — if the playbook hasn't already pinned an order, ask the customer to pick from their recent orders.
2. **Show the line items** — clean HTML list with product name + quantity, each with a checkbox.
3. **Customer ticks the missing ones.**
4. **Confirm quantities** — for each ticked item, ask how many were missing (defaults to the full ordered qty).

## Fully live / code-driven (no AI-prepared snapshot)

Both render AND completion pull data **live** — the launch only stores identification (`{codeDriven, liveRendered, journeyType, ticketId, workspaceId}`), never AI-prepared steps or `metadata.lineItems`. The loader (`api/journey/[token]/route.ts`) rebuilds steps+metadata via `buildJourneySteps` on every click, and `api/journey/[token]/complete/route.ts` does the **same rebuild** to resolve the index-based answers (`item_0:damaged`) back to real line items.

**Gotcha (fixed 2026-06-09):** completion used to read `metadata.lineItems` from the frozen `config_snapshot`, which the live-render launch path never populates. With `lineItems=[]`, `parseItemAccounting` couldn't map `item_0` → an item, silently dropped the report, and returned `allReceived:true`. A customer who correctly reported damaged coffee got "nothing for us to fix" → eventually a manual refund. Two safeguards now: (1) completion rebuilds line items live; (2) if the customer flagged *any* issue but parsing still resolves zero items, completion **replaces the whole order** rather than auto-closing as "all received OK." Never silently convert a flagged issue into no-replacement.

## On submit

The submission is returned to the parent playbook execution. The playbook then:

1. Generates an internal note listing what's missing.
2. Decides whether the missing items qualify for an automatic replacement (against the playbook's policy + customer's prior replacement history).
3. If eligible → creates the [[../tables/replacements]] order via `src/lib/replacement-order.ts` → [[../integrations/shopify]] `draftOrderCreate` → `draftOrderComplete` to push the new fulfillable order.
4. If not eligible (over threshold, suspected abuse) → escalates to agent.

## Files

| File | Purpose |
|---|---|
| `src/lib/missing-items-journey-builder.ts` | Builder |
| `src/lib/playbook-executor.ts` | Calls into this journey from the replacement-order playbook |
| `src/lib/replacement-order.ts` | Builds the replacement draft order |
| `src/lib/shopify-draft-orders.ts` | Shopify draft order creation |
| `src/app/journey/[token]/page.tsx` | Mini-site form renderer |
| `src/app/api/journey/[token]/complete/route.ts` | Return data to playbook |

## Related

[[../playbooks/replacement-order]] · [[../tables/orders]] · [[../tables/replacements]] · [[../integrations/shopify]] · [[../tables/journey_definitions]]
