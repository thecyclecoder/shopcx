import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { createAdminClient } from "@/lib/supabase/admin";

// ── Shopify GraphQL helper ──

async function shopifyGQL(
  workspaceId: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL error: ${res.status} ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }
  return json.data;
}

// ── Mutations ──

const CREDIT_MUTATION = `
  mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
    storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
      storeCreditAccountTransaction {
        id
        amount { amount currencyCode }
        account { id balance { amount currencyCode } }
      }
      userErrors { message field }
    }
  }
`;

const DEBIT_MUTATION = `
  mutation storeCreditAccountDebit($id: ID!, $debitInput: StoreCreditAccountDebitInput!) {
    storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
      storeCreditAccountTransaction {
        id
        amount { amount currencyCode }
        account { id balance { amount currencyCode } }
      }
      userErrors { message field }
    }
  }
`;

const BALANCE_QUERY = `
  query GetCustomerStoreCredit($id: ID!) {
    customer(id: $id) {
      storeCreditAccounts(first: 5) {
        nodes {
          id
          balance { amount currencyCode }
          transactions(first: 20) {
            nodes {
              ... on StoreCreditAccountCreditTransaction {
                id
                amount { amount currencyCode }
                balanceAfterTransaction { amount currencyCode }
                createdAt
                expiresAt
              }
              ... on StoreCreditAccountDebitTransaction {
                id
                amount { amount currencyCode }
                balanceAfterTransaction { amount currencyCode }
                createdAt
              }
              ... on StoreCreditAccountExpirationTransaction {
                amount { amount currencyCode }
                balanceAfterTransaction { amount currencyCode }
                createdAt
              }
            }
          }
        }
      }
    }
  }
`;

// ── Types ──

export interface StoreCreditParams {
  workspaceId: string;
  customerId: string;
  shopifyCustomerId: string;
  amount: number;
  reason: string;
  issuedBy: string;       // workspace_member ID
  issuedByName: string;   // display_name snapshot
  ticketId?: string;
  subscriptionId?: string;
}

export interface StoreCreditResult {
  ok: boolean;
  balance: number;
  transactionId: string | null;
  error?: string;
}

export interface StoreCreditLogEntry {
  id: string;
  type: string;
  amount: number;
  currency: string;
  reason: string | null;
  issued_by_name: string;
  ticket_id: string | null;
  subscription_id: string | null;
  balance_after: number | null;
  created_at: string;
}

// ── Issue store credit ──

export async function issueStoreCredit(params: StoreCreditParams): Promise<StoreCreditResult> {
  const customerGid = `gid://shopify/Customer/${params.shopifyCustomerId}`;

  const data = await shopifyGQL(params.workspaceId, CREDIT_MUTATION, {
    id: customerGid,
    creditInput: {
      creditAmount: { amount: params.amount.toFixed(2), currencyCode: "USD" },
    },
  });

  const result = data.storeCreditAccountCredit as {
    storeCreditAccountTransaction: { id: string; account: { balance: { amount: string } } } | null;
    userErrors: { message: string }[];
  };

  if (result.userErrors?.length) {
    return { ok: false, balance: 0, transactionId: null, error: result.userErrors[0].message };
  }

  const txn = result.storeCreditAccountTransaction!;
  const balance = parseFloat(txn.account.balance.amount);

  // Log to DB
  const admin = createAdminClient();
  await admin.from("store_credit_log").insert({
    workspace_id: params.workspaceId,
    customer_id: params.customerId,
    shopify_customer_id: params.shopifyCustomerId,
    type: "credit",
    amount: params.amount,
    currency: "USD",
    reason: params.reason,
    issued_by: params.issuedBy,
    issued_by_name: params.issuedByName,
    ticket_id: params.ticketId || null,
    subscription_id: params.subscriptionId || null,
    shopify_transaction_id: txn.id,
    balance_after: balance,
  });

  // Internal ticket note if from ticket context
  if (params.ticketId) {
    await admin.from("ticket_messages").insert({
      ticket_id: params.ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `💳 Store credit of $${params.amount.toFixed(2)} issued by ${params.issuedByName}. Reason: ${params.reason}`,
    });
  }

  return { ok: true, balance, transactionId: txn.id };
}

// ── Debit store credit ──

export async function debitStoreCredit(params: StoreCreditParams): Promise<StoreCreditResult> {
  const customerGid = `gid://shopify/Customer/${params.shopifyCustomerId}`;

  const data = await shopifyGQL(params.workspaceId, DEBIT_MUTATION, {
    id: customerGid,
    debitInput: {
      debitAmount: { amount: params.amount.toFixed(2), currencyCode: "USD" },
    },
  });

  const result = data.storeCreditAccountDebit as {
    storeCreditAccountTransaction: { id: string; account: { balance: { amount: string } } } | null;
    userErrors: { message: string }[];
  };

  if (result.userErrors?.length) {
    return { ok: false, balance: 0, transactionId: null, error: result.userErrors[0].message };
  }

  const txn = result.storeCreditAccountTransaction!;
  const balance = parseFloat(txn.account.balance.amount);

  const admin = createAdminClient();
  await admin.from("store_credit_log").insert({
    workspace_id: params.workspaceId,
    customer_id: params.customerId,
    shopify_customer_id: params.shopifyCustomerId,
    type: "debit",
    amount: params.amount,
    currency: "USD",
    reason: params.reason,
    issued_by: params.issuedBy,
    issued_by_name: params.issuedByName,
    ticket_id: params.ticketId || null,
    subscription_id: params.subscriptionId || null,
    shopify_transaction_id: txn.id,
    balance_after: balance,
  });

  if (params.ticketId) {
    await admin.from("ticket_messages").insert({
      ticket_id: params.ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `💳 Store credit of $${params.amount.toFixed(2)} debited by ${params.issuedByName}. Reason: ${params.reason}`,
    });
  }

  return { ok: true, balance, transactionId: txn.id };
}

// ── Query balance from Shopify ──

export async function getStoreCreditBalance(
  workspaceId: string,
  shopifyCustomerId: string,
): Promise<{ balance: number; currency: string }> {
  const customerGid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const data = await shopifyGQL(workspaceId, BALANCE_QUERY, { id: customerGid });

  const customer = data.customer as {
    storeCreditAccounts: { nodes: { id: string; balance: { amount: string; currencyCode: string } }[] };
  } | null;

  const nodes = customer?.storeCreditAccounts?.nodes;
  if (!nodes?.length) {
    return { balance: 0, currency: "USD" };
  }

  let total = 0;
  let currency = "USD";
  for (const node of nodes) {
    total += parseFloat(node.balance.amount);
    currency = node.balance.currencyCode;
  }

  return { balance: total, currency };
}

// ── History from DB ──

export async function getStoreCreditHistory(
  workspaceId: string,
  customerId: string,
): Promise<StoreCreditLogEntry[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("store_credit_log")
    .select("id, type, amount, currency, reason, issued_by_name, ticket_id, subscription_id, balance_after, created_at")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(50);

  return (data || []) as StoreCreditLogEntry[];
}
