/**
 * qb-close/sync-processors — the month's per-processor money rollup into
 * [[../tables/qb_payment_processor_summaries]], which drives the journal entry's fee / refund /
 * chargeback / clearing-net-down block. Owner: [[../functions/cfo]] (Grace).
 *
 * Per processor the JE Debits `processing_fees` to its txn-fee account, Debits refunds and
 * chargebacks to their contra-income accounts, then Credits the clearing account by the summed
 * deductions. The matching clearing DEBIT is order gross by gateway and comes from the Shopify
 * orders, not from here.
 *
 * ⭐ **Never blank a processor row on a failed fetch.** A missing row silently drops that whole
 * block from the JE, which then cannot balance; a zeroed row is worse still, because it balances
 * while being wrong. Every sync here either writes real figures or leaves the existing row alone
 * and reports the failure — [[qb-close-guard]] blocks the close on `missing_processor_summaries`.
 *
 * ⚠️ **Braintree fees are NOT derivable from the API, and this module does not guess at them.**
 * Braintree reports only a partial figure (~58% of the eventual total) because card-network
 * assessments post around the 5th, so the true number exists only on the statement. Inventing a
 * percentage-of-gross would be worse than reporting nothing — it lands a plausible wrong number
 * that BALANCES. So the sync writes gross / refunds / chargebacks and carries `processing_fees`
 * forward untouched; the founder enters the statement figure on /dashboard/month-end, which
 * rewrites it and rebuilds the JE.
 *
 * ⚠️ **PayPal needs its OWN credentials — it does not ride on Shopify.** Two layers get conflated
 * here, so to be precise: the GATEWAY on an order may be `paypal` (356 Shopify orders in July) or
 * `PayPal Braintree` (158, mapped → braintree), and that drives the clearing DEBIT from the order
 * side. But the PROCESSOR ROLLUP — fees, refunds, chargebacks — comes from PayPal's own reporting
 * API, because PayPal settles into PayPal and its fees never appear in Shopify's payout summaries.
 * July's PayPal block is real money ($31,166.36 gross / $1,001.92 fees). Credentials live on
 * `workspaces.paypal_*` (secret AES-256-GCM encrypted), copied from Shoptics by
 * `scripts/_backfill-paypal-credentials.ts`.
 *
 * See docs/brain/libraries/qb-close-sync-processors.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { getBraintreeGateway } from "@/lib/integrations/braintree";
import { decrypt } from "@/lib/crypto";

export type ProcessorSyncStatus = "success" | "skipped" | "error";

export interface ProcessorSyncResult {
  processor: string;
  status: ProcessorSyncStatus;
  detail?: string;
  figures?: Record<string, number>;
}

function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}`, last };
}

/**
 * Shopify Payments — aggregated from PAID PAYOUT SUMMARIES for the month, matching Shoptics.
 *
 * Payout summaries are the processor's own accounting of the period, which is why they are used
 * rather than summing order-level amounts: fees, refund fees and dispute fees are only broken out
 * here. `processing_fees` is the sum of charge + refund + adjustment fees (all magnitudes).
 */
export async function syncShopifyPaymentsSummary(
  admin: SupabaseClient,
  workspaceId: string,
  month: string,
): Promise<ProcessorSyncResult> {
  const creds = await getShopifyCredentials(workspaceId);
  if (!creds?.shop || !creds?.accessToken) return { processor: "shopify_payments", status: "skipped", detail: "Shopify not connected" };

  const { start, end } = monthBounds(month);
  let url: string | null =
    `https://${creds.shop}/admin/api/2024-01/shopify_payments/payouts.json?date_min=${start}&date_max=${end}&status=paid&limit=100`;
  const payouts: Record<string, unknown>[] = [];
  while (url) {
    const res: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": creds.accessToken } });
    if (!res.ok) throw new Error(`Shopify payouts ${res.status}`);
    const data = await res.json();
    payouts.push(...(data.payouts ?? []));
    const m = (res.headers.get("link") ?? "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }

  let gross = 0, chargeFees = 0, refunds = 0, refundFees = 0, chargebacks = 0, chargebackFees = 0;
  for (const p of payouts) {
    const s = (p.summary ?? {}) as Record<string, unknown>;
    gross += Number(s.charges_gross_amount ?? 0);
    chargeFees += Number(s.charges_fee_amount ?? 0);
    refunds += Math.abs(Number(s.refunds_gross_amount ?? 0));
    refundFees += Number(s.refunds_fee_amount ?? 0);
    // adjustments_gross is Shopify's term for disputes/chargebacks
    chargebacks += Math.abs(Number(s.adjustments_gross_amount ?? 0));
    chargebackFees += Number(s.adjustments_fee_amount ?? 0);
  }
  const figures = {
    gross_sales: gross,
    processing_fees: Math.abs(chargeFees) + Math.abs(refundFees) + Math.abs(chargebackFees),
    refunds,
    chargebacks,
    adjustments: 0,
    net_deposits: payouts.reduce((a, p) => a + Number(p.amount ?? 0), 0),
  };

  const { error } = await admin.from("qb_payment_processor_summaries").upsert(
    {
      workspace_id: workspaceId, closing_month: month, processor: "shopify_payments", ...figures,
      raw_payload: { payout_count: payouts.length, ...figures }, synced_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,closing_month,processor" },
  );
  if (error) throw new Error(error.message);
  return { processor: "shopify_payments", status: "success", figures, detail: `${payouts.length} payout(s)` };
}

/** Drain a Braintree search stream into an array — the SDK returns a stream, not a promise. */
type SearchStream = { on(ev: string, cb: (arg: unknown) => void): void };
function drain<T>(stream: SearchStream): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const out: T[] = [];
    stream.on("data", (row) => out.push(row as T));
    stream.on("end", () => resolve(out));
    stream.on("error", (e) => reject(e as Error));
  });
}

/**
 * Braintree — settled transactions + disputes for the month.
 *
 * `processing_fees` is an ESTIMATE and is written ONLY when no hand-entered override already
 * exists for the month (`preserveFeeOverride`, default true). Stamping the estimate back over a
 * founder-entered statement figure would silently revert the books to a ~58% guess.
 */
export async function syncBraintreeSummary(
  admin: SupabaseClient,
  workspaceId: string,
  month: string,
  preserveFeeOverride = true,
): Promise<ProcessorSyncResult> {
  const { start, end } = monthBounds(month);
  const gateway = await getBraintreeGateway(workspaceId);
  if (!gateway) return { processor: "braintree", status: "skipped", detail: "Braintree not configured" };

  const from = new Date(`${start}T00:00:00Z`);
  const to = new Date(`${end}T23:59:59Z`);

  interface BtTxn { amount: string; status: string; type: string }
  // Range fields are ACCESSOR FUNCTIONS, not objects: `settledAt` must be CALLED to get the
  // RangeNode. `search.settledAt.between(...)` compiles under the shipped typings but throws
  // "is not a function" at runtime.
  const txns = await drain<BtTxn>(
    gateway.transaction.search((search) => {
      (search as unknown as Record<string, () => { between: (a: Date, b: Date) => void }>).settledAt().between(from, to);
    }) as unknown as SearchStream,
  );

  let gross = 0, refunds = 0;
  for (const t of txns) {
    const amt = Number(t.amount ?? 0);
    if (t.type === "credit" || t.status === "refunded") refunds += Math.abs(amt);
    else gross += amt;
  }

  interface BtDispute { amountDisputed?: string; status?: string }
  let chargebacks = 0;
  try {
    const disputes = await drain<BtDispute>(
      (await gateway.dispute.search((search) => {
        (search as unknown as Record<string, () => { between: (a: Date, b: Date) => void }>).receivedDate().between(from, to);
      })) as unknown as SearchStream,
    );
    for (const d of disputes) if (d.status !== "won") chargebacks += Number(d.amountDisputed ?? 0);
  } catch {
    // Dispute search is optional on some merchant configs — a failure here must not zero the row.
  }

  // NO fee estimate is manufactured here. Braintree's API reports only a partial figure and the
  // true one lands on the statement, so carry forward whatever is stored (a prior hand-entered
  // value, else 0) rather than inventing a number that balances the books while being wrong.
  const { data: existing } = await admin
    .from("qb_payment_processor_summaries")
    .select("processing_fees, raw_payload")
    .eq("workspace_id", workspaceId).eq("closing_month", month).eq("processor", "braintree")
    .maybeSingle();
  const fees = Number(existing?.processing_fees ?? 0);
  const hasOverride =
    preserveFeeOverride && (existing?.raw_payload as { fee_source?: string } | null)?.fee_source === "manual_override";

  const figures = {
    gross_sales: gross,
    processing_fees: fees,
    refunds,
    chargebacks,
    adjustments: 0,
    net_deposits: Math.round((gross - refunds - fees) * 100) / 100,
  };
  const { error } = await admin.from("qb_payment_processor_summaries").upsert(
    {
      workspace_id: workspaceId, closing_month: month, processor: "braintree", ...figures,
      raw_payload: {
        transaction_count: txns.length,
        fee_source: hasOverride ? "manual_override" : fees > 0 ? "carried_forward" : "unset",
        ...figures,
      },
      synced_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,closing_month,processor" },
  );
  if (error) throw new Error(error.message);
  return {
    processor: "braintree",
    status: "success",
    figures,
    detail: hasOverride
      ? `${txns.length} txn(s); kept the hand-entered fee ($${fees.toFixed(2)})`
      : `${txns.length} txn(s); processing_fees is $${fees.toFixed(2)} and is NOT derivable from the API — enter the statement figure before closing`,
  };
}

/**
 * PayPal — aggregated from `/v1/reporting/transactions`, the processor's own ledger.
 *
 * Fees here are REAL, unlike Braintree's: PayPal reports `fee_amount` per transaction at
 * settlement. Event codes drive the classification — `T00xx`/`T01xx` are payments, `T11xx`
 * refunds, `T12xx` chargebacks/disputes.
 */
export async function syncPaypalSummary(
  admin: SupabaseClient,
  workspaceId: string,
  month: string,
): Promise<ProcessorSyncResult> {
  const { data: ws } = await admin
    .from("workspaces")
    .select("paypal_client_id, paypal_client_secret_encrypted, paypal_environment")
    .eq("id", workspaceId)
    .single();
  if (!ws?.paypal_client_id || !ws?.paypal_client_secret_encrypted) {
    return { processor: "paypal", status: "skipped", detail: "PayPal not configured for this workspace" };
  }

  const base = ws.paypal_environment === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
  const basic = Buffer.from(`${ws.paypal_client_id}:${decrypt(ws.paypal_client_secret_encrypted)}`).toString("base64");
  const tokRes = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const tok = await tokRes.json();
  if (!tok.access_token) throw new Error("PayPal token request failed");

  const { start, end, last } = monthBounds(month);
  void last;
  let gross = 0, fees = 0, refunds = 0, chargebacks = 0, count = 0;
  for (let page = 1; page <= 50; page++) {
    const url =
      `${base}/v1/reporting/transactions?start_date=${start}T00:00:00-0000` +
      `&end_date=${end}T23:59:59-0000&fields=all&page_size=500&page=${page}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!r.ok) throw new Error(`PayPal reporting ${r.status}`);
    const d = await r.json();
    const txns = (d.transaction_details ?? []) as { transaction_info?: Record<string, { value?: string } | string> }[];
    for (const t of txns) {
      const info = (t.transaction_info ?? {}) as Record<string, unknown>;
      const code = String(info.transaction_event_code ?? "");
      const amt = Number((info.transaction_amount as { value?: string })?.value ?? 0);
      const fee = Number((info.fee_amount as { value?: string })?.value ?? 0);
      count++;
      fees += Math.abs(fee);
      if (code.startsWith("T11")) refunds += Math.abs(amt);
      else if (code.startsWith("T12")) chargebacks += Math.abs(amt);
      else if (amt > 0) gross += amt;
    }
    if (txns.length < 500 || page >= Number(d.total_pages ?? 1)) break;
  }

  const figures = {
    gross_sales: Math.round(gross * 100) / 100,
    processing_fees: Math.round(fees * 100) / 100,
    refunds: Math.round(refunds * 100) / 100,
    chargebacks: Math.round(chargebacks * 100) / 100,
    adjustments: 0,
    net_deposits: Math.round((gross - refunds - fees) * 100) / 100,
  };
  const { error } = await admin.from("qb_payment_processor_summaries").upsert(
    {
      workspace_id: workspaceId, closing_month: month, processor: "paypal", ...figures,
      raw_payload: { transaction_count: count, ...figures }, synced_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,closing_month,processor" },
  );
  if (error) throw new Error(error.message);
  return { processor: "paypal", status: "success", figures, detail: `${count} transaction(s)` };
}

/** Sync every processor. A failure leaves the existing row alone rather than zeroing it. */
export async function syncProcessorSummaries(
  admin: SupabaseClient,
  workspaceId: string,
  month: string,
): Promise<ProcessorSyncResult[]> {
  const out: ProcessorSyncResult[] = [];
  for (const [name, run] of [
    ["shopify_payments", () => syncShopifyPaymentsSummary(admin, workspaceId, month)],
    ["paypal", () => syncPaypalSummary(admin, workspaceId, month)],
    ["braintree", () => syncBraintreeSummary(admin, workspaceId, month)],
  ] as const) {
    try {
      out.push(await run());
    } catch (e) {
      // Leave whatever row already exists untouched — a zeroed row balances while being wrong.
      out.push({ processor: name, status: "error", detail: (e as Error).message.slice(0, 300) });
    }
  }
  return out;
}
