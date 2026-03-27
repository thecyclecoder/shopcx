# Feature: AI-Driven Profile Linking

## What to Build

Before the AI agent takes any action on a ticket, it checks if the customer has potential linked profiles. If a match is found, it asks the customer to confirm, links the profiles, and then proceeds with the original question — all without counting against the AI turn limit.

## Flow

```
Customer sends message
  → AI checks for potential profile matches (suggestions API)
  → If match found and not already linked:
      Turn 1 (system, doesn't count): "Is [other email] also your email?"
      Customer confirms
      Turn 2 (system, doesn't count): "Got it, I've linked your accounts!"
      → Link profiles via existing customer_links system
      → Re-assemble context with combined data
  → Proceed with original question (Turn 1 of real support)
```

## Database Changes

### tickets table
```sql
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS profile_link_completed BOOLEAN DEFAULT false;
```
This prevents the AI from asking about linking on every turn. Once checked (whether linked or no match), it's done for this ticket.

## Code Changes

### 1. `src/lib/ai-context.ts` — Add linked profile check

Before assembling customer context, check for linked profiles:
```typescript
// After loading customer, check if already linked
const { data: links } = await admin
  .from("customer_links")
  .select("group_id")
  .eq("customer_id", customer.id);

if (links?.length) {
  // Already linked — load combined data
  // (existing behavior, just make sure orders/subs query across linked profiles)
}
```

### 2. `src/lib/inngest/ai-multi-turn.ts` — Profile linking step

Add a new step BEFORE the context assembly:

```typescript
// Step 1b: Profile linking check (only on first message of a new ticket)
if (!ticket.profile_link_completed) {
  const linkCheck = await step.run("check-profile-links", async () => {
    // Call the existing suggestions API
    const { data: suggestions } = await admin
      .from("customers")
      .select("id, email, first_name, last_name")
      .eq("workspace_id", workspace_id)
      .neq("id", customer.id)
      // Match by name
      .eq("first_name", customer.first_name)
      .eq("last_name", customer.last_name);

    // Filter to high-confidence matches (same name, different email)
    const matches = suggestions?.filter(s =>
      s.email !== customer.email &&
      // Not already linked
      !existingLinks.includes(s.id)
    );

    if (matches?.length) {
      return { shouldAsk: true, matchEmail: matches[0].email, matchId: matches[0].id };
    }

    // Mark as checked so we don't ask again
    await admin.from("tickets").update({ profile_link_completed: true }).eq("id", ticket_id);
    return { shouldAsk: false };
  });

  if (linkCheck.shouldAsk) {
    // Send the linking question (doesn't count as a turn)
    // ... create message asking about the other email
    // Wait for customer response
    // If confirmed, link profiles
    // Then re-assemble context
  }
}
```

### 3. Turn counting

The multi-turn handler's turn increment only happens in the "send-response" step. Profile linking messages should:
- Use `author_type: "ai"` so they show in chat
- NOT increment `ai_turn_count`
- Be tagged with a metadata marker so we know they're system turns

### 4. Detection of confirmation

When the AI asks "Is [email] also yours?" and the customer responds:
- "Yes" / "Yeah" / "That's me" → Link profiles
- "No" / "Not mine" / "Different person" → Skip, mark as checked
- Anything else → Treat as "no" and proceed with original question

### 5. The linking question message

The AI should say something natural like:
"Before I look into that for you — I want to make sure I have your complete account pulled up. Is dylanralston@gmail.com also your email address?"

If confirmed:
"Perfect, I've linked your accounts so I can see your full order history. Now let me help you with [original question]..."

## Important Rules

- Only check ONCE per ticket (profile_link_completed flag)
- Only ask if there's a high-confidence name match
- Never reveal the other profile's order/subscription details BEFORE confirmation
- Linking turns don't count against ai_turn_limit
- If customer says no, drop it immediately and move on
- If no match found, skip silently (no message to customer)

## Testing

1. Create a customer "Test User" at test1@example.com with orders
2. Create another "Test User" at test2@example.com with different orders
3. Start a chat as test1@example.com
4. AI should ask "Is test2@example.com also yours?"
5. Confirm → profiles linked → combined order history visible
6. Original question answered with full context
7. Verify ai_turn_count only incremented for the actual answer, not the linking turns

## When Done
This can be built directly on main or in a worktree.
