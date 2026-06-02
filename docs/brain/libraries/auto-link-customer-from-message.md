# libraries/auto-link-customer-from-message

Extract order numbers / emails / phones from inbound messages → propose customer link.

**File:** `src/lib/auto-link-customer-from-message.ts`

## File header

```
Pre-orchestrator helper: scan a customer's latest inbound message
for email addresses that match existing-but-unlinked customer
profiles in the same workspace, and link them automatically.
The motivating case (ticket 9f87b748): customer wrote in from email
A complaining about charges, and explicitly mentioned "my
husband's email is B" in the same message. The orchestrator
shouldn't have to ask the linking question — the answer is
already in the message. By linking before Sonnet runs, the
orchestrator's get_customer_account tool returns the merged
subscription set, and it can route straight to the right journey
(cancel, in that case).
Mirrors the same logic already in launchJourneyForTicket's
"fast path" for the account_linking journey, but runs PROACTIVELY
on every customer inbound — not just after we've already sent the
linking journey.
Returns the number of new links made + the linked email(s) for
logging. Never throws — auto-linking is best-effort, the
orchestrator runs regardless.
```

## Exports

### `autoLinkCustomerFromMessage` — function

```ts
async function autoLinkCustomerFromMessage(admin: SupabaseClient, workspaceId: string, ticketId: string, customerId: string,) : Promise<AutoLinkResult>
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
