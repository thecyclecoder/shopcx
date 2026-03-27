# Worktree: Gorgias Ticket History Import

## Setup
```bash
cd /Users/admin/Projects/shopcx
git worktree add ../shopcx-gorgias-import feature/gorgias-import
cd ../shopcx-gorgias-import
npm install
```

Work in `/Users/admin/Projects/shopcx-gorgias-import` — NOT main.

## What to Build

Import historical tickets from Gorgias so agents have context when they switch to ShopCX. This is a one-time import script, NOT production code.

## Gorgias API Credentials
Available in `.env.local`:
```
GORGIAS_DOMAIN=superfoodscompany
GORGIAS_EMAIL=dylan@superfoodscompany.com
GORGIAS_API_KEY=6c8aedae672ff64626df2e64b950572da7e28f80accba245662560a0bee21587
```

## Gorgias API

### List Tickets
```
GET https://superfoodscompany.gorgias.com/api/tickets?limit=100&order_by=created_datetime:desc&cursor=XXX
Authorization: Basic base64(email:api_key)
```

### Get Ticket Messages
```
GET https://superfoodscompany.gorgias.com/api/tickets/{id}/messages?limit=30
Authorization: Basic base64(email:api_key)
```

## Import Script: `scripts/import-gorgias-tickets.ts`

### Strategy
- Import last 90 days of closed tickets (these have full conversations)
- Skip open/pending tickets (those are active in Gorgias)
- Map Gorgias data → ShopCX schema
- Match customers by email
- Batch process: 100 tickets per page, paginate through all

### Field Mapping

**Ticket:**
| Gorgias | ShopCX |
|---------|--------|
| id | (store as `gorgias_id` tag) |
| subject | subject |
| status | status (closed) |
| channel | channel (email) |
| created_datetime | created_at |
| closed_datetime | resolved_at |
| customer.email | → lookup customer_id |
| tags[].name | tags[] |

**Messages:**
| Gorgias | ShopCX |
|---------|--------|
| body_text | body |
| from_agent (true) | direction: outbound, author_type: agent |
| from_agent (false) | direction: inbound, author_type: customer |
| created_datetime | created_at |

### Implementation

```typescript
#!/usr/bin/env npx tsx
// scripts/import-gorgias-tickets.ts

import { createClient } from "@supabase/supabase-js";

const GORGIAS_DOMAIN = process.env.GORGIAS_DOMAIN!;
const GORGIAS_EMAIL = process.env.GORGIAS_EMAIL!;
const GORGIAS_API_KEY = process.env.GORGIAS_API_KEY!;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const auth = Buffer.from(`${GORGIAS_EMAIL}:${GORGIAS_API_KEY}`).toString("base64");
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// 1. Paginate through closed tickets
// 2. For each ticket, fetch messages
// 3. Find customer by email
// 4. Insert ticket + messages
// 5. Rate limit: 2 requests/second to Gorgias API
```

### Important Notes
- **DO NOT** import into production while Gorgias is still active — agents might see duplicates
- Add a `source: "gorgias_import"` or tag `gorgias-import` to all imported tickets
- Skip tickets that already exist (check by subject + customer + date)
- Rate limit Gorgias API calls (they have limits)
- The script should be idempotent — safe to run multiple times
- Keep this as a standalone script, NOT in the app code (per project conventions)

### Add `gorgias_id` column (optional)
If you want to track which Gorgias ticket maps to which ShopCX ticket:
```sql
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS gorgias_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_gorgias ON tickets(workspace_id, gorgias_id) WHERE gorgias_id IS NOT NULL;
```

## Testing
1. Run import on a small batch first (10 tickets)
2. Verify tickets appear in queue with correct data
3. Verify messages are in correct order
4. Verify customer linking works
5. Then run full 90-day import

## When Done
Push to `feature/gorgias-import` branch. Tell the merge manager (main terminal) to merge.
