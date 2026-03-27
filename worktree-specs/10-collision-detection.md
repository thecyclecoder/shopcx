# Worktree: Ticket Collision Detection

## Setup
```bash
cd /Users/admin/Projects/shopcx
git worktree add ../shopcx-collision feature/collision-detection
cd ../shopcx-collision
npm install
```

Work in `/Users/admin/Projects/shopcx-collision` — NOT main.

## What to Build

Show when another agent is viewing or typing on the same ticket. Prevents two agents from replying to the same ticket simultaneously.

## Implementation: Supabase Realtime Presence

Use Supabase Realtime's presence feature — no new database tables needed.

### Ticket Detail Page (`src/app/dashboard/tickets/[id]/page.tsx`)

When an agent opens a ticket:
1. Join a Realtime presence channel: `ticket-presence:${ticketId}`
2. Track state: `{ userId, userName, viewing: true, typing: false }`
3. When typing in the reply composer: update presence with `typing: true`
4. When leaving the page: leave the channel (auto-cleanup)

### Display
At the top of the ticket conversation, show:
- "[Agent Name] is viewing this ticket" — small banner, subtle
- "[Agent Name] is typing..." — when they're in the composer
- Multiple agents: "Dylan and Sarah are viewing this ticket"

### UI Component: `src/components/ticket-presence.tsx`
```typescript
"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface PresenceState {
  userId: string;
  userName: string;
  typing: boolean;
}

export default function TicketPresence({ ticketId, currentUserId, currentUserName }: {
  ticketId: string;
  currentUserId: string;
  currentUserName: string;
}) {
  const [others, setOthers] = useState<PresenceState[]>([]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`ticket-presence:${ticketId}`, {
      config: { presence: { key: currentUserId } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<PresenceState>();
        const otherUsers = Object.values(state)
          .flat()
          .filter(u => u.userId !== currentUserId);
        setOthers(otherUsers);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ userId: currentUserId, userName: currentUserName, typing: false });
        }
      });

    return () => { supabase.removeChannel(channel); };
  }, [ticketId, currentUserId, currentUserName]);

  if (others.length === 0) return null;

  const typing = others.filter(o => o.typing);
  const viewing = others.filter(o => !o.typing);

  return (
    <div className="...banner styles...">
      {typing.length > 0 && <span>{typing.map(t => t.userName).join(", ")} is typing...</span>}
      {viewing.length > 0 && typing.length === 0 && <span>{viewing.map(v => v.userName).join(", ")} is viewing</span>}
    </div>
  );
}
```

### Typing Indicator
In the reply composer, when the agent types:
```typescript
// Debounced: update presence typing state
const updateTyping = debounce((isTyping: boolean) => {
  channel.track({ userId, userName, typing: isTyping });
}, 500);

// On input: updateTyping(true)
// On blur or 3s idle: updateTyping(false)
```

## Files to Create/Modify
- `src/components/ticket-presence.tsx` — Presence component
- Modify `src/app/dashboard/tickets/[id]/page.tsx` — Add presence component + typing tracker

## No Database Changes
Supabase Realtime Presence is ephemeral — no persistence needed.

## Testing
1. Open same ticket in two browser tabs (different users if possible, or same user)
2. Verify "viewing" indicator appears
3. Type in reply → verify "typing..." appears in other tab
4. Close tab → verify presence clears

## When Done
Push to `feature/collision-detection` branch. Tell the merge manager (main terminal) to merge.
