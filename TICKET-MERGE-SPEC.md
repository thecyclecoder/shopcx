# Ticket Merge System — Spec

## Overview
Single merge function used by both bulk action (agent UI) and Sonnet (auto-merge). Always merges old ticket(s) into the newest ticket. Old tickets are archived with a `merged_into` reference.

## Rules
1. **Direction:** Always merge INTO the newest ticket (by `created_at`)
2. **Customer guard:** All tickets must belong to the same customer OR linked accounts (via `customer_links`)
3. **No archived sources:** Don't merge an already-archived ticket (it may already be merged)
4. **No self-merge:** Can't merge a ticket into itself
5. **Messages:** Move with original `created_at` timestamps — no new message events triggered
6. **State carry-forward:** Tags, playbook state, journey state from old tickets carry into the new ticket (append tags, don't overwrite active playbook)
7. **Old ticket disposition:** Set status → `archived`, set `merged_into` → new ticket ID, add system note "Merged into ticket {new_ticket_id}"
8. **Channel-safe:** Works for all channels. Live chat sessions stay on the new ticket. Email threads stay on the new ticket.

## Database Changes

### `tickets` table
```sql
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES tickets(id);
```

When `merged_into` is set, the ticket is a merge artifact — archived, not actionable, but preserved for history.

## Merge Function

**Location:** `src/lib/ticket-merge.ts`

```typescript
export async function mergeTickets(
  workspaceId: string,
  ticketIds: string[],  // 2 or more ticket IDs
): Promise<{ targetTicketId: string; mergedCount: number; messagesMoved: number }>
```

### Steps:
1. Fetch all tickets, verify same workspace
2. Verify all belong to same customer or linked accounts
3. Reject any that are already archived
4. Sort by `created_at` — newest is the target
5. For each old ticket:
   a. Move all messages to target ticket (update `ticket_id`, keep `created_at`)
   b. Append old ticket's tags to target (deduplicate)
   c. If old ticket has playbook/journey state and target doesn't, carry forward
   d. Archive old ticket: `status: "archived"`, `archived_at: now`, `merged_into: targetTicketId`
   e. Add system note on old ticket: "[System] This ticket was merged into ticket {targetId}"
   f. Add system note on target: "[System] Merged {n} messages from ticket {oldSubject}"
6. Return result

### Linked Account Check:
```
Given customerIds from all tickets:
- If all same customer_id → OK
- If different customer_ids → check customer_links table for shared group_id
- If no shared group → reject merge
```

## Entry Points

### 1. Bulk Action (existing)
**File:** `src/app/api/tickets/merge/route.ts` (or wherever it is now)
- Agent selects 2+ tickets → clicks merge
- Calls `mergeTickets(workspaceId, selectedTicketIds)`
- Returns result to UI

### 2. Sonnet Auto-Merge
**In the unified ticket handler**, after Sonnet resolves the customer:
- Check if customer has other open/pending/closed (non-archived) tickets
- If yes, ask Sonnet: "Customer has ticket {subject} from {date}. Is this new message about the same issue?"
- If Sonnet says yes → call `mergeTickets(workspaceId, [oldTicketId, currentTicketId])`
- Continue processing on the (now enriched) target ticket
- Sonnet now has full conversation history for context

### Sonnet Context for Archived/Merged Tickets
When Sonnet loads conversation history and sees an archived ticket with `merged_into`:
- Don't include it as a separate ticket
- Note: "Previous conversation was merged into this ticket" 
- The merged messages are already on the active ticket

## UI Changes

### Ticket Detail
- If ticket has `merged_into` set, show banner: "This ticket was merged into [linked ticket]"
- Click navigates to the active ticket

### Ticket List
- Merged/archived tickets don't show in default view (existing behavior)
- Searching by customer still finds them in archived filter

## What NOT to merge
- Archived tickets (already processed)
- Tickets from unlinked customers
- Tickets Sonnet determines are about different issues
