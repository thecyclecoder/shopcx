# Worktree: Live Chat Widget

## Setup
```bash
cd /Users/admin/Projects/shopcx
git worktree add ../shopcx-chat-widget feature/chat-widget
cd ../shopcx-chat-widget
npm install
```

Work in `/Users/admin/Projects/shopcx-chat-widget` — NOT main.

## What to Build

An embeddable JavaScript chat widget that customers can use on the Shopify store. Messages create tickets with `channel: "chat"` and show up in the agent queue in real-time.

## Architecture Overview

```
Customer's Browser                    ShopCX
┌──────────────┐    WebSocket     ┌──────────────┐
│ Chat Widget  │◄────────────────►│ Supabase     │
│ (iframe)     │    (Realtime)    │ Realtime     │
│              │                  │              │
│ REST API ────┼──────────────────┤ Next.js API  │
│ (create msg) │    POST          │ routes       │
└──────────────┘                  └──────────────┘
                                         │
                                  ┌──────┴──────┐
                                  │ Agent sees  │
                                  │ ticket in   │
                                  │ queue +     │
                                  │ real-time   │
                                  │ messages    │
                                  └─────────────┘
```

## Components

### 1. Widget Embed Script (`public/widget.js`)

Lightweight script customers add to their store:
```html
<script src="https://shopcx.ai/widget.js" data-workspace="WORKSPACE_ID"></script>
```

The script:
- Creates an iframe pointing to `/widget/[workspaceId]`
- Positions it fixed bottom-right
- Shows a chat bubble icon
- Click to expand/collapse
- Stores session in localStorage (so conversations persist across pages)

### 2. Widget Page (`src/app/widget/[workspaceId]/page.tsx`)

Client component rendered inside the iframe:
- Chat UI: message list + input field
- No auth required (anonymous customers)
- Identifies customer by email (asked at start) or session token
- Subscribes to Supabase Realtime for new messages on the ticket
- Sends messages via REST API

**Flow:**
1. Widget opens → asks for name + email (or loads from localStorage)
2. Customer types message → POST to `/api/widget/[workspaceId]/messages`
3. API creates ticket (if new) or adds message to existing
4. Widget subscribes to Realtime `ticket_messages` INSERT events
5. Agent replies show up in real-time
6. AI multi-turn can also handle chat tickets (channel: "chat")

### 3. Widget API

#### `src/app/api/widget/[workspaceId]/messages/route.ts`

POST — Create message (no auth, public endpoint):
```typescript
{
  email: string;        // Customer email
  name?: string;        // Customer name
  message: string;      // Message body
  session_id?: string;  // From localStorage, links to existing ticket
}
```

Logic:
1. Find or create customer by email
2. If session_id provided, find existing open ticket for this session
3. If no open ticket, create new one with `channel: "chat"`, `subject: "Live Chat"`
4. Insert message as `direction: inbound, author_type: customer`
5. Return `{ ticket_id, session_id, message_id }`
6. Fire `ai/reply-received` if AI is enabled for chat channel

#### `src/app/api/widget/[workspaceId]/messages/route.ts` (GET)

GET — Fetch messages for a session:
```typescript
?session_id=xxx
```
Returns messages for the ticket, ordered by created_at.

### 4. Realtime Subscription

In the widget page, subscribe to Supabase Realtime:
```typescript
const channel = supabase
  .channel(`ticket:${ticketId}`)
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'ticket_messages',
    filter: `ticket_id=eq.${ticketId}`,
  }, (payload) => {
    // Add new message to chat
  })
  .subscribe();
```

Use the anon key (public) — RLS allows SELECT for authenticated users, but for the widget we need a public policy or use a widget-specific API.

### 5. Database Changes

#### Migration: `widget_sessions` table
```sql
CREATE TABLE public.widget_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  email TEXT,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_activity_at TIMESTAMPTZ DEFAULT now()
);
```

#### Widget settings on workspace
```sql
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS widget_enabled BOOLEAN DEFAULT false;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS widget_color TEXT DEFAULT '#4f46e5';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS widget_greeting TEXT DEFAULT 'Hi! How can we help you today?';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS widget_position TEXT DEFAULT 'bottom-right';
```

### 6. Widget Settings UI

In Settings, add a "Live Chat Widget" card:
- Enable/disable toggle
- Color picker (primary color)
- Greeting message text
- Position: bottom-right or bottom-left
- Embed code snippet (copy to clipboard)

### 7. Agent Experience

Chat tickets already work in the existing ticket queue and detail page. The key additions:
- Ticket detail should show real-time messages (already polls every 10s, but for chat switch to Realtime subscription)
- Show "typing..." indicator when customer is typing (optional, nice to have)
- Chat tickets should have shorter response delay (already: 5s for chat channel)

## Widget UI Design

```
┌─────────────────────────┐
│ ● Superfoods Company    │  ← workspace name + logo
│   We typically reply    │
│   in a few minutes      │
├─────────────────────────┤
│                         │
│  [Bot] Hi! How can we   │
│  help you today?        │
│                         │
│         [Customer msg]  │
│                         │
│  [Agent] Response here  │
│                         │
├─────────────────────────┤
│ Type a message...  [▶]  │
└─────────────────────────┘
```

- Clean, minimal design matching the workspace branding
- Messages alternate left (support) and right (customer)
- Timestamps on messages
- "Powered by ShopCX.ai" footer link

## Security
- Widget API is public (no auth) but rate-limited
- Email is required to start a chat (prevents spam)
- Widget only works on domains the workspace has whitelisted (CORS check via workspace settings, or just open initially)
- No sensitive data exposed — customer sees only their own messages

## Testing
1. Enable widget on workspace
2. Add embed script to a test page
3. Open chat, send message → verify ticket created in queue
4. Reply from agent dashboard → verify appears in widget
5. Test AI auto-reply on chat channel
6. Test persistence across page refreshes (session_id in localStorage)

## When Done
Push to `feature/chat-widget` branch. Tell the merge manager (main terminal) to merge.
