# Gorgias Ticket Analysis & Smart Pattern System

## 1. GORGIAS API ACCESS

Base URL: https://superfoodscompany.gorgias.com/api/
Auth: HTTP Basic (email:apikey)
Email: dylan@superfoodscompany.com
API Key: 6c8aedae672ff64626df2e64b950572da7e28f80accba245662560a0bee21587

### Pull Tickets
GET /tickets?limit=100&order_by=created_datetime:desc
- Cursor pagination: use meta.next_cursor for next page
- No status filter param — filter in code
- Fields: id, subject, status, channel, via, customer, assignee_user, tags, messages_count,
  created_datetime, closed_datetime, excerpt, summary, integrations, language, priority

### Pull Messages for a Ticket
GET /tickets/{id}/messages?limit=10&order_by=created_datetime:asc
- First message with from_agent=false is the customer's initial message
- body_text has plain text, body_html has HTML

### Key API Quirks
- order_by format: "created_datetime:desc" (not separate order_dir param)
- status filter doesn't work as a query param — filter in code
- Pagination uses cursor, not offset
- Auth is Basic not Bearer

---

## 2. TICKET PULL SCRIPT

```javascript
const auth = Buffer.from('dylan@superfoodscompany.com:6c8aedae672ff64626df2e64b950572da7e28f80accba245662560a0bee21587').toString('base64');
const BASE = 'https://superfoodscompany.gorgias.com/api';

async function pullClosedTickets(monthsBack = 6) {
  const since = new Date();
  since.setMonth(since.getMonth() - monthsBack);
  const sinceISO = since.toISOString();

  let allTickets = [];
  let cursor = null;

  while (true) {
    let url = BASE + '/tickets?limit=100&order_by=created_datetime:desc';
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);

    const res = await fetch(url, {
      headers: { Authorization: 'Basic ' + auth },
    });
    const data = await res.json();
    if (data.error) { console.log('Error:', JSON.stringify(data.error)); break; }

    const tickets = data.data || [];
    if (tickets.length === 0) break;

    let pastCutoff = false;
    for (const t of tickets) {
      if (t.created_datetime < sinceISO) { pastCutoff = true; break; }
      if (t.status === 'closed') {
        allTickets.push({
          id: t.id,
          subject: t.subject,
          status: t.status,
          channel: t.channel,
          via: t.via,
          created_at: t.created_datetime,
          closed_at: t.closed_datetime,
          messages_count: t.messages_count,
          customer_email: t.customer?.email,
          customer_name: t.customer?.name,
          assignee_email: t.assignee_user?.email,
          tags: (t.tags || []).map(tag => tag.name),
          language: t.language,
          priority: t.priority,
          excerpt: t.excerpt,
        });
      }
    }

    if (pastCutoff || !data.meta?.next_cursor) break;
    cursor = data.meta.next_cursor;
  }
  return allTickets;
}

// Pull first customer message for a ticket
async function getFirstCustomerMessage(ticketId) {
  const res = await fetch(BASE + '/tickets/' + ticketId + '/messages?limit=5&order_by=created_datetime:asc', {
    headers: { Authorization: 'Basic ' + auth },
  });
  const data = await res.json();
  const custMsg = (data.data || []).find(m => m.from_agent === false);
  if (!custMsg) return null;
  return (custMsg.body_text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

---

## 3. DATA PULLED (6 months: Sep 2025 - Mar 2026)

Total closed tickets: 9,676
Raw data file: /Users/admin/Projects/logistics/gorgias_tickets.json

### By Channel
- email: 7,440
- chat: 661
- phone: 590
- api: 369
- contact_form: 344
- help-center: 188
- sms: 23
- facebook: 48
- instagram-ad-comment: 6
- instagram-direct-message: 5
- tiktok-shop: 1
- facebook-messenger: 1

### By Month
- Sep 2025: 463 (partial)
- Oct 2025: 1,953
- Nov 2025: 1,641
- Dec 2025: 1,412
- Jan 2026: 1,429
- Feb 2026: 1,426
- Mar 2026: 1,352 (partial)

### Top 15 Tags
- during-business-hours: 9,671
- auto-close: 2,394
- non-support-related: 2,394
- handled-by-siena: 2,114
- vip: 1,946
- returnrequest: 1,743
- urgent: 1,610
- callrequested: 1,586
- cancel_request: 1,482
- ORDER-STATUS: 1,199
- ORDER-CHANGE/CANCEL: 1,147
- auto-assign-from-siena: 1,119
- modify_subscription: 1,010
- subscription: 853
- cancel: 810

---

## 4. PATTERN CATEGORIES

### WHERE_IS_ORDER (auto-respond with tracking)
- "where is my order"
- "where's my order"
- "can you tell me where my order is"
- "have not received"
- "haven't received"
- "not received"
- "no delivery"
- "nothing had been delivered"
- "still have not received"
- "did not receive"
- "we did not receive"
- "taking so long"
- "stuck in transit"
- "has been delayed"
- "where is it"

### TRACKING_STATUS (auto-respond with carrier status)
- "tracking"
- "tracking info"
- "tracking number"
- "track my"
- "shipment status"
- "delivery status"
- "check this shipment"
- "shipping update"
- "in transit"
- "been stuck"

### NOT_DELIVERED_MARKED (escalate to agent)
- "says delivered"
- "has been delivered" + negative context
- "not delivered"
- "didn't receive"
- "lost"
- "stolen"
- "missing package"
- "no sign of this delivery"
- "check what address"

### SUBSCRIPTION_MANAGEMENT (auto-action via Shopify API)
- "when is my next shipment"
- "when will my order ship"
- "next order"
- "next shipment"
- "when will it be shipped"
- "when will it arrive"
- "when will i receive"
- "ship now"
- "ship right away"
- "move up"
- "ship asap"
- "unable to determine when"
- "order schedule"
- "change frequency"
- "change delivery date"
- "pause my orders"
- "skip my order"
- "hold my orders"

---

## 5. SMART PATTERN SYSTEM ARCHITECTURE

### Database Schema

```sql
-- Global patterns (ship with the product)
CREATE TABLE global_patterns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category TEXT NOT NULL,
  pattern TEXT NOT NULL,
  match_type TEXT DEFAULT 'contains',  -- 'contains', 'starts_with', 'regex'
  priority INT DEFAULT 50,
  auto_action TEXT,             -- 'respond_tracking', 'escalate', 'lookup_subscription'
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Workspace-specific patterns (discovered per-customer)
CREATE TABLE workspace_patterns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID,
  category TEXT NOT NULL,
  pattern TEXT NOT NULL,
  match_type TEXT DEFAULT 'contains',
  priority INT DEFAULT 50,
  auto_action TEXT,
  status TEXT DEFAULT 'suggested',  -- 'suggested', 'approved', 'rejected'
  source TEXT,                      -- 'nightly_analyzer', 'manual'
  sample_ticket_ids JSONB,
  occurrence_count INT DEFAULT 1,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Pattern Matching Logic

```javascript
function matchPatterns(text, globalPatterns, workspacePatterns) {
  const normalized = text
    .toLowerCase()
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s''-]/g, '')
    .trim();

  // Strip email signatures/quoted replies
  const cleaned = normalized
    .split(/(?:sent from|get outlook|on .+ wrote:|from:|----)/)[0]
    .trim();

  const allPatterns = [...globalPatterns, ...workspacePatterns]
    .filter(p => p.active)
    .sort((a, b) => b.priority - a.priority);

  for (const pattern of allPatterns) {
    let matched = false;
    switch (pattern.match_type) {
      case 'contains':
        matched = cleaned.includes(pattern.pattern.toLowerCase());
        break;
      case 'starts_with':
        matched = cleaned.startsWith(pattern.pattern.toLowerCase());
        break;
      case 'regex':
        matched = new RegExp(pattern.pattern, 'i').test(cleaned);
        break;
    }
    if (matched) return pattern;
  }
  return null;
}
```

### Matching Priority
1. Check subject line first (email tickets)
2. If no match, check first customer message body
3. First match wins — NOT_DELIVERED (priority 90) beats WHERE_IS_ORDER (priority 50)

### Auto-Response Flow

```
INCOMING TICKET
  │
  ├─ Pattern match → WHERE_IS_ORDER or TRACKING_STATUS
  │    ├─ Look up customer email → most recent Shopify order
  │    ├─ Check fulfillment state:
  │    │    ├─ Unfulfilled → "Your order is being prepared, expected to ship within 2-3 days"
  │    │    ├─ Fulfilled + tracking → Check carrier API
  │    │    │    ├─ In Transit + within 7-10 days → auto-reply with tracking status
  │    │    │    ├─ In Transit + >10 days → Escalate to agent
  │    │    │    ├─ Delivered → "Records show delivered on [date]"
  │    │    │    └─ Exception/Returned → Escalate to agent
  │    │    └─ No order found → ask for order number
  │
  ├─ Pattern match → NOT_DELIVERED
  │    └─ Escalate to agent (potential lost package claim)
  │
  ├─ Pattern match → SUBSCRIPTION_MGMT
  │    ├─ Look up subscription via Shopify API
  │    └─ Auto-respond or take action
  │
  └─ No match → Leave for agent, add to nightly analyzer queue
```

### Nightly Pattern Analyzer

```
DAILY CRON:
  1. Pull all tickets from last 24h that were NOT smart-tagged
  2. Extract first customer message from each
  3. Use Claude API to cluster similar messages and suggest new patterns
  4. Save suggestions to workspace_patterns with status='suggested'
  5. Surface on dashboard for admin approval
```

---

## 6. SAMPLE REAL CUSTOMER MESSAGES

### WHERE_IS_ORDER:
- "Can you tell me where my order is? It's now March 21, and I don't have it."
- "I have still not received this order and somehow I was charged for a second order"
- "Haven't received my coffee in Fort Lauderdale"
- "Why is this order taking so long to arrive?"
- "I still have not received my order..the tracking says that it is delayed due to weather"
- "I paid for expedited shipping It has been a week and I don't even have a shipping update yet"

### TRACKING_STATUS:
- "My order has been stuck in transit"
- "Hi! Can you please check this shipment? It shows to be shipped Friday but the tracking info is not there"
- "I ordered the superfood tabs Friday and just wondering when they will be delivered to me"

### NOT_DELIVERED_MARKED:
- "Nothing had been delivered" (reply to delivered notification)
- "We did not receive our package. Please check what address it was left at"
- "Hello! Checked all over the property and mailbox and no sign of this delivery"
- "No creamer was delivered"

### SUBSCRIPTION_MANAGEMENT:
- "Can you tell me when my next shipment going to be sent"
- "I would like my next order shipped now"
- "my next shipment is scheduled for March 6. i'd like to have it ship right away"
- "How do I change the delivery date for my subscription?"
- "Please pause my orders. I have a lot!!"
- "When is my next shipment?"
- "Please hold my orders until May 1st"

---

## 7. KEY INSIGHTS

- ~25% of tickets are auto-closed non-support (spam, marketing replies)
- Siena AI handles ~22% of tickets
- Top support driver: returns/exchanges (1,743 tickets)
- Second: cancellations (1,482) — major churn signal
- Order status + subscription management = ~2,200+ tickets (automatable)
- Most tickets are replies to Shopify notification emails
- Customers often reply to "delivered" notifications saying they DIDN'T receive it
- VIP tag on 1,946 tickets — 20% of support load is high-value customers
- Phone callback requests: 1,586 — many customers want human contact
