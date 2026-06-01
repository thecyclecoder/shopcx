/**
 * Avalara (AvaTax) client. Used by the new custom storefront checkout
 * + the in-house subscription scheduler to calculate sales tax and
 * report committed sales for filing.
 *
 * Auth: Basic, account_id as username + license key as password.
 * Environment: sandbox-rest.avatax.com (testing) or rest.avatax.com (prod).
 *
 * Two-phase pattern for a checkout:
 *   1. createTransaction({ commit: false }) — at order-review step, get
 *      authoritative tax to display + charge.
 *   2. createTransaction({ commit: true }) — after payment success, lock
 *      in the transaction in Avalara for filing. Same `code` (our order
 *      ID) → idempotent.
 *
 * For refunds: refundTransaction({ code, refundType, lines }).
 * For voids: voidTransaction({ code }) — only useful before the sale
 * settles / before Avalara files.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const SANDBOX_HOST = "https://sandbox-rest.avatax.com";
const PROD_HOST = "https://rest.avatax.com";
const API_VERSION = "/api/v2";

export interface AvalaraAddress {
  line1: string;
  line2?: string;
  city: string;
  region: string;       // 2-letter state code, e.g. "TX"
  postalCode: string;
  country: string;      // 2-letter country code, e.g. "US"
}

export interface AvalaraLineItem {
  number: string;          // line identifier (e.g., "1", "2", or SKU)
  amount: number;          // total line amount in dollars (not cents), pre-tax
  quantity: number;
  taxCode?: string;        // e.g., "PF050144" for supplements; falls back to workspace default
  description?: string;
  itemCode?: string;       // SKU
}

export interface CreateTransactionParams {
  code: string;             // OUR internal order code — idempotent identifier
  customerCode: string;     // OUR customer id / email — used by Avalara for exemption rules
  date: string;             // ISO date "YYYY-MM-DD"
  lines: AvalaraLineItem[];
  shipTo: AvalaraAddress;
  commit: boolean;          // false = quote, true = lock in for filing
  type?: "SalesOrder" | "SalesInvoice" | "ReturnOrder" | "ReturnInvoice";
}

export interface CreateTransactionResult {
  success: boolean;
  error?: string;
  transactionCode?: string;
  totalTaxCents?: number;
  totalAmountCents?: number;     // pre-tax subtotal
  totalCents?: number;            // subtotal + tax
  lines?: Array<{ lineNumber: string; tax: number; taxableAmount: number }>;
  raw?: unknown;                 // full Avalara response for diagnostics
}

interface WorkspaceCreds {
  accountId: string;
  licenseKey: string;
  companyCode: string;
  environment: "sandbox" | "production";
  origin: AvalaraAddress;
  defaultTaxCode: string | null;
}

async function loadCreds(workspaceId: string): Promise<WorkspaceCreds | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("avalara_account_id, avalara_license_key_encrypted, avalara_company_code, avalara_environment, avalara_origin_address, avalara_default_tax_code, avalara_enabled")
    .eq("id", workspaceId)
    .single();
  if (!data?.avalara_enabled) return null;
  if (!data.avalara_account_id || !data.avalara_license_key_encrypted) return null;
  if (!data.avalara_origin_address) return null;
  return {
    accountId: data.avalara_account_id,
    licenseKey: decrypt(data.avalara_license_key_encrypted),
    companyCode: data.avalara_company_code || "DEFAULT",
    environment: (data.avalara_environment || "sandbox") as "sandbox" | "production",
    origin: data.avalara_origin_address as AvalaraAddress,
    defaultTaxCode: data.avalara_default_tax_code,
  };
}

function authHeader(creds: WorkspaceCreds): string {
  return "Basic " + Buffer.from(`${creds.accountId}:${creds.licenseKey}`).toString("base64");
}

function hostFor(env: "sandbox" | "production"): string {
  return env === "production" ? PROD_HOST : SANDBOX_HOST;
}

/**
 * Create a tax transaction in Avalara. If commit=true, the transaction
 * is locked for filing; if false, it's a quote that can be later
 * adjusted or replaced with a committed version.
 *
 * Idempotency: same `code` + same company yields the same transaction
 * (Avalara dedups). Safe to retry on network errors.
 */
export async function createTransaction(
  workspaceId: string,
  params: CreateTransactionParams,
): Promise<CreateTransactionResult> {
  const creds = await loadCreds(workspaceId);
  if (!creds) return { success: false, error: "Avalara not configured for this workspace" };

  const host = hostFor(creds.environment);
  const body = {
    type: params.type || (params.commit ? "SalesInvoice" : "SalesOrder"),
    companyCode: creds.companyCode,
    date: params.date,
    code: params.code,
    customerCode: params.customerCode,
    addresses: {
      shipFrom: {
        line1: creds.origin.line1,
        line2: creds.origin.line2,
        city: creds.origin.city,
        region: creds.origin.region,
        postalCode: creds.origin.postalCode,
        country: creds.origin.country,
      },
      shipTo: {
        line1: params.shipTo.line1,
        line2: params.shipTo.line2,
        city: params.shipTo.city,
        region: params.shipTo.region,
        postalCode: params.shipTo.postalCode,
        country: params.shipTo.country,
      },
    },
    lines: params.lines.map(l => ({
      number: l.number,
      amount: l.amount,
      quantity: l.quantity,
      taxCode: l.taxCode || creds.defaultTaxCode || undefined,
      description: l.description,
      itemCode: l.itemCode,
    })),
    commit: params.commit,
  };

  const res = await fetch(`${host}${API_VERSION}/transactions/createoradjust`, {
    method: "POST",
    headers: {
      "Authorization": authHeader(creds),
      "Content-Type": "application/json",
      "X-Avalara-Client": "ShopCX-Integration; 1.0",
    },
    body: JSON.stringify({ createTransactionModel: body }),
  });

  const data = await res.json().catch(() => null) as { totalTax?: number; totalAmount?: number; code?: string; lines?: Array<{ lineNumber: string; tax: number; taxableAmount: number }>; error?: { message: string; details?: Array<{ message: string }> } } | null;
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.details?.[0]?.message || `HTTP ${res.status}`;
    return { success: false, error: msg, raw: data };
  }

  return {
    success: true,
    transactionCode: data?.code,
    totalTaxCents: data?.totalTax != null ? Math.round(data.totalTax * 100) : undefined,
    totalAmountCents: data?.totalAmount != null ? Math.round(data.totalAmount * 100) : undefined,
    totalCents: (data?.totalAmount != null && data?.totalTax != null) ? Math.round((data.totalAmount + data.totalTax) * 100) : undefined,
    lines: data?.lines,
    raw: data,
  };
}

/**
 * Void a previously-committed transaction. Use BEFORE the period is
 * filed. After filing, use `refundTransaction` instead.
 */
export async function voidTransaction(
  workspaceId: string,
  transactionCode: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await loadCreds(workspaceId);
  if (!creds) return { success: false, error: "Avalara not configured" };

  const host = hostFor(creds.environment);
  const res = await fetch(
    `${host}${API_VERSION}/companies/${encodeURIComponent(creds.companyCode)}/transactions/${encodeURIComponent(transactionCode)}/void`,
    {
      method: "POST",
      headers: {
        "Authorization": authHeader(creds),
        "Content-Type": "application/json",
        "X-Avalara-Client": "ShopCX-Integration; 1.0",
      },
      body: JSON.stringify({ code: "DocVoided" }),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    return { success: false, error: data?.error?.message || `HTTP ${res.status}` };
  }
  return { success: true };
}

/**
 * Issue a refund/return against a committed transaction. Use for
 * post-filing refunds — creates a new ReturnInvoice that Avalara
 * tracks for the next filing period.
 *
 * Pass refundType='Full' for a full refund (entire original tx),
 * 'Partial' with `lines` for partial refund of specific line items,
 * 'TaxOnly' to refund just the tax portion.
 */
export async function refundTransaction(
  workspaceId: string,
  params: {
    transactionCode: string;
    refundCode: string;            // new code for the refund tx (e.g., "REFUND-SC131727-001")
    date: string;                  // ISO date
    refundType: "Full" | "Partial" | "TaxOnly" | "Percentage";
    refundPercentage?: number;
    refundLines?: string[];        // line numbers to refund (Partial only)
  },
): Promise<{ success: boolean; error?: string; refundTaxCents?: number }> {
  const creds = await loadCreds(workspaceId);
  if (!creds) return { success: false, error: "Avalara not configured" };

  const host = hostFor(creds.environment);
  const res = await fetch(
    `${host}${API_VERSION}/companies/${encodeURIComponent(creds.companyCode)}/transactions/${encodeURIComponent(params.transactionCode)}/refund`,
    {
      method: "POST",
      headers: {
        "Authorization": authHeader(creds),
        "Content-Type": "application/json",
        "X-Avalara-Client": "ShopCX-Integration; 1.0",
      },
      body: JSON.stringify({
        refundTransactionCode: params.refundCode,
        refundDate: params.date,
        refundType: params.refundType,
        refundPercentage: params.refundPercentage,
        refundLines: params.refundLines,
      }),
    },
  );
  const data = await res.json().catch(() => null) as { totalTax?: number; error?: { message?: string } } | null;
  if (!res.ok) {
    return { success: false, error: data?.error?.message || `HTTP ${res.status}` };
  }
  return {
    success: true,
    refundTaxCents: data?.totalTax != null ? Math.round(data.totalTax * 100) : undefined,
  };
}

/**
 * Connection test. Calls Avalara's `ping` endpoint with the configured
 * credentials. Used by the Settings UI to verify creds work before
 * flipping `avalara_enabled=true`.
 */
export async function pingAvalara(
  accountId: string,
  licenseKey: string,
  environment: "sandbox" | "production",
): Promise<{ success: boolean; error?: string; authenticated?: boolean; companyName?: string }> {
  const host = hostFor(environment);
  const auth = "Basic " + Buffer.from(`${accountId}:${licenseKey}`).toString("base64");

  // /utilities/ping is the cheapest reachability check. The
  // `authenticated` flag should be true when basic auth is accepted —
  // but in practice the field is often false even for valid creds
  // (sandbox can answer auth=None even on a successful basic-auth
  // request). So we follow up with /companies, which 401s cleanly on
  // bad creds and returns the account's company list on good ones —
  // giving us both a real auth check and the company name.
  const pingRes = await fetch(`${host}${API_VERSION}/utilities/ping`, {
    headers: { "Authorization": auth, "X-Avalara-Client": "ShopCX-Integration; 1.0" },
  });
  if (!pingRes.ok) {
    const d = await pingRes.json().catch(() => null) as { error?: { message?: string } } | null;
    return { success: false, error: d?.error?.message || `HTTP ${pingRes.status}` };
  }

  const compRes = await fetch(`${host}${API_VERSION}/companies?$top=1`, {
    headers: { "Authorization": auth, "X-Avalara-Client": "ShopCX-Integration; 1.0" },
  });
  if (compRes.status === 401) {
    return { success: false, error: "Authentication failed — check account ID and license key" };
  }
  if (!compRes.ok) {
    const d = await compRes.json().catch(() => null) as { error?: { message?: string } } | null;
    return { success: false, error: d?.error?.message || `HTTP ${compRes.status}` };
  }
  const compData = await compRes.json().catch(() => null) as { value?: Array<{ name?: string }> } | null;
  return {
    success: true,
    authenticated: true,
    companyName: compData?.value?.[0]?.name,
  };
}
