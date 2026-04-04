# Store Credit — Spec

## Overview

Native Shopify store credit integration. Admins can issue store credit to customers as compensation for issues. Uses Shopify's `storeCreditAccountCredit` / `storeCreditAccountDebit` GraphQL mutations. Full audit trail of every credit/debit with who issued it and why.

---

## 1. Shopify App Setup

### 1a. Scopes
Add to `shopify-extension/shopify.app.toml` access_scopes:
- `read_store_credit_account_transactions`
- `write_store_credit_account_transactions`

### 1b. GraphQL mutations used

**Issue credit:**
```graphql
mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
  storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
    storeCreditAccountTransaction {
      amount { amount currencyCode }
      account { id balance { amount currencyCode } }
    }
    userErrors { message field }
  }
}
```
- `$id` = `gid://shopify/Customer/{shopify_customer_id}`
- `creditInput.creditAmount` = `{ amount: "25.00", currencyCode: "USD" }`
- `creditInput.expiresAt` = optional, null for no expiry

**Debit (clawback, if needed):**
```graphql
mutation storeCreditAccountDebit($id: ID!, $debitInput: StoreCreditAccountDebitInput!) {
  storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
    storeCreditAccountTransaction {
      amount { amount currencyCode }
      account { id balance { amount currencyCode } }
    }
    userErrors { message field }
  }
}
```

**Query balance:**
```graphql
query {
  customer(id: "gid://shopify/Customer/{id}") {
    storeCreditAccounts(first: 5) {
      edges {
        node {
          id
          balance { amount currencyCode }
        }
      }
    }
  }
}
```

---

## 2. Database

### Migration: `supabase/migrations/XXXXXX_store_credit_log.sql`

```sql
CREATE TABLE store_credit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  shopify_customer_id text NOT NULL,
  type text NOT NULL,                -- 'credit' or 'debit'
  amount numeric NOT NULL,           -- always positive, type indicates direction
  currency text NOT NULL DEFAULT 'USD',
  reason text,                       -- free text note from admin
  issued_by uuid NOT NULL REFERENCES workspace_members(id),
  issued_by_name text NOT NULL,      -- display_name snapshot at time of issue
  ticket_id uuid REFERENCES tickets(id),  -- optional: if issued from a ticket
  subscription_id text,              -- optional: if issued from subscription context
  shopify_transaction_id text,       -- Shopify store credit transaction GID
  balance_after numeric,             -- balance after this transaction
  created_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE store_credit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_read" ON store_credit_log
  FOR SELECT USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "service_role_all" ON store_credit_log
  FOR ALL USING (true) WITH CHECK (true);

-- Index for customer lookups
CREATE INDEX idx_store_credit_log_customer ON store_credit_log (workspace_id, customer_id);
CREATE INDEX idx_store_credit_log_ticket ON store_credit_log (ticket_id) WHERE ticket_id IS NOT NULL;
```

---

## 3. Core Logic (`src/lib/store-credit.ts`)

### Functions

**`issueStoreCredit(params)`**
```typescript
{
  workspaceId: string;
  customerId: string;          // our DB customer ID
  shopifyCustomerId: string;
  amount: number;              // dollars, e.g., 25.00
  reason: string;
  issuedBy: string;            // workspace_member ID
  issuedByName: string;        // display_name
  ticketId?: string;
  subscriptionId?: string;
}
```
1. Call Shopify `storeCreditAccountCredit` with customer GID + amount
2. Extract transaction ID and new balance from response
3. Insert row into `store_credit_log`
4. If `ticketId` provided: create internal ticket note — "Store credit of ${amount} issued by {display_name}. Reason: {reason}"
5. Return `{ ok: true, balance, transactionId }`

**`debitStoreCredit(params)`** — same shape, calls `storeCreditAccountDebit`. For clawbacks on fraud/chargebacks.

**`getStoreCreditBalance(workspaceId, shopifyCustomerId)`**
1. Call Shopify `customer.storeCreditAccounts` query
2. Return USD balance (or 0 if no account)

**`getStoreCreditHistory(workspaceId, customerId)`**
1. Query `store_credit_log` for this customer, ordered by `created_at DESC`
2. Return array of log entries

---

## 4. API Endpoint

### `POST /api/store-credit/issue`

- Auth: require admin or owner role
- Body: `{ customerId, amount, reason, ticketId?, subscriptionId? }`
- Validates: amount > 0, amount <= 500 (sanity cap, configurable), customer exists, user is admin/owner
- Calls `issueStoreCredit()`
- Returns `{ ok: true, balance }`

### `POST /api/store-credit/debit`

- Auth: require admin or owner role
- Body: `{ customerId, amount, reason }`
- Calls `debitStoreCredit()`

### `GET /api/store-credit/balance?customerId={id}`

- Auth: any workspace member
- Returns `{ balance, currency }`

### `GET /api/store-credit/history?customerId={id}`

- Auth: any workspace member
- Returns `{ history: [...] }` from `store_credit_log`

---

## 5. Dashboard UI — Issue Store Credit

Store credit action available in three places. All use the same modal component.

### 5a. Issue Store Credit Modal

- Title: "Issue store credit"
- Fields:
  - Amount (number input, required, min $1, max $500)
  - Reason (textarea, required — "Why are you issuing this credit?")
- Footer: "Issue ${amount} credit" primary button + Cancel ghost button
- On success: toast "Store credit of ${amount} issued", refresh balance display
- On error: toast with error message

### 5b. Customer detail page (`/dashboard/customers/[id]`)
- "Issue store credit" button in customer actions area (admin/owner only)
- Opens modal, pre-fills customer context
- Below the button: current store credit balance display

### 5c. Ticket detail page (`/dashboard/tickets/[id]`)
- "Issue store credit" action in customer sidebar section (admin/owner only)
- Opens modal, pre-fills customer + ticket context (logs note to ticket)
- Show current balance inline

### 5d. Subscription detail page (`/dashboard/subscriptions/[id]`)
- "Issue store credit" in customer info / actions area (admin/owner only)
- Opens modal, pre-fills customer + subscription context

---

## 6. Customer Sidebar — Balance Display

Add store credit balance to the existing customer sidebar (shown on ticket detail and elsewhere):
- "Store credit: $X.XX" — fetched from Shopify on load
- If $0.00, show "Store credit: None"
- Small link: "View history" → expands or navigates to show `store_credit_log` entries for this customer

---

## 7. Store Credit History

### 7a. Customer detail page
- New "Store Credit" section/tab showing:
  - Current balance (from Shopify)
  - Full history from `store_credit_log`: date, type (credit/debit), amount, reason, issued by, ticket link (if applicable)
  - Sorted newest first

### 7b. Internal ticket notes
- Every store credit issuance from a ticket creates an internal note visible to agents
- Format: "💳 Store credit of $25.00 issued by {display_name}. Reason: {reason}"

---

## 8. AI Agent Context

Add to `ai-context.ts` assembler:
- Include store credit balance in customer profile section
- AI can reference: "I see you have $X.XX in store credit on your account"
- AI should NOT issue store credit — only agents/admins can

---

## 9. Chargeback Integration

Extend existing chargeback processing:
- When a chargeback is confirmed (status `lost`) and the customer had been issued store credit related to that order:
  - Option to auto-debit the store credit amount via `debitStoreCredit`
  - Log with type `'debit'`, reason `'Chargeback clawback — order #{order_id}'`
  - This is optional/configurable, not automatic by default

---

## File Summary

| File | Purpose |
|------|---------|
| `shopify-extension/shopify.app.toml` | Add store credit scopes |
| `src/lib/store-credit.ts` | Core logic: issue, debit, query balance, history |
| `src/app/api/store-credit/issue/route.ts` | Issue credit endpoint (admin only) |
| `src/app/api/store-credit/debit/route.ts` | Debit credit endpoint (admin only) |
| `src/app/api/store-credit/balance/route.ts` | Balance query endpoint |
| `src/app/api/store-credit/history/route.ts` | History query endpoint |
| `src/components/store-credit-modal.tsx` | Shared issue store credit modal |
| `src/app/dashboard/tickets/[id]/page.tsx` | Add issue action to ticket sidebar |
| `src/app/dashboard/customers/[id]/page.tsx` | Add issue action + balance + history |
| `src/app/dashboard/subscriptions/[id]/page.tsx` | Add issue action |
| `supabase/migrations/XXXXXX_store_credit_log.sql` | store_credit_log table + RLS |

## Implementation Order

1. Shopify app scopes update
2. DB migration (store_credit_log)
3. `src/lib/store-credit.ts` — core logic with Shopify GraphQL
4. API endpoints (issue, debit, balance, history)
5. Store credit modal component
6. Customer detail: issue action + balance + history section
7. Ticket detail: issue action in sidebar + internal note
8. Subscription detail: issue action
9. Customer sidebar: balance display
10. AI context integration
