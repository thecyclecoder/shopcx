/**
 * POST /api/qb/month-end-closing — run the month-end close.
 *
 * **Shadow by default.** `{ month }` computes all 5 artifacts, records a dry-run verdict, and
 * writes NOTHING to QuickBooks. Posting requires an explicit `{ post: true }` AND passing
 * [[qb-close/close-guard]] `assertPostable` — proven dry run + not already closed.
 *
 * MANUAL TRIGGER ONLY — deliberately not wired to any cron. The InventoryAdjustment and the
 * three SalesReceipts are not idempotent (no void, no dedup), so an automatic retry would
 * duplicate real QuickBooks documents and corrupt inventory. A human presses this.
 *
 * GET ?month=YYYY-MM returns the current eligibility + the latest dry-run verdict, so the UI can
 * show why a month can or cannot post without running anything.
 *
 * See docs/brain/libraries/qb-close-run.md.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { qboFetch } from "@/lib/quickbooks";
import { runMonthEndClose } from "@/lib/qb-close/run-close";
import { assertPostable } from "@/lib/qb-close/close-guard";
import type { ShopifyOrder } from "@/lib/qb-close/journal-entry";
import { annotateGatewayAmounts } from "@/lib/qb-close/gateway-amounts";
import { getShopifyCredentials } from "@/lib/shopify-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function lastDayOf(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/**
 * The month's Shopify orders — the JE's revenue / tax / shipping / discount / clearing-debit
 * basis.
 *
 * ⚠️ Without the `read_all_orders` scope the Admin API returns only ~60 trailing days, so a close
 * run late silently under-reports AND STILL BALANCES. `staleWindow` surfaces that rather than
 * letting it pass quietly.
 */
async function fetchShopifyOrders(
  workspaceId: string,
  month: string,
): Promise<{ orders: ShopifyOrder[]; earliest: string | null; staleWindow: boolean; split: { resolved: number; failed: number; correction: number } }> {
  const creds = await getShopifyCredentials(workspaceId);
  if (!creds?.shop || !creds?.accessToken) throw new Error("Shopify is not connected for this workspace");
  const last = String(lastDayOf(month)).padStart(2, "0");
  let url: string | null =
    `https://${creds.shop}/admin/api/2024-01/orders.json?status=any&limit=250` +
    `&created_at_min=${month}-01T00:00:00Z&created_at_max=${month}-${last}T23:59:59Z` +
    `&fields=id,created_at,line_items,total_shipping_price_set,total_tax,total_discounts,subtotal_price,total_price,payment_gateway_names,financial_status`;
  const orders: ShopifyOrder[] = [];
  let earliest: string | null = null;
  while (url) {
    const res: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": creds.accessToken } });
    if (!res.ok) throw new Error(`Shopify orders fetch failed (${res.status})`);
    const data = await res.json();
    for (const o of data.orders ?? []) {
      const created = String(o.created_at).slice(0, 10);
      if (!earliest || created < earliest) earliest = created;
      if (["paid", "partially_refunded", "refunded"].includes(o.financial_status)) orders.push(o as ShopifyOrder);
    }
    const m = (res.headers.get("link") ?? "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  // Resolve the ACTUAL captured amount per gateway on split-payment orders. Without it the JE
  // divides the total equally among every gateway ATTEMPTED, crediting clearing accounts that
  // received nothing — $1,540.23 of misallocation across July's 12 split-payment orders.
  const split = await annotateGatewayAmounts(
    orders as (ShopifyOrder & { id?: number | string })[],
    creds.shop,
    creds.accessToken,
  );

  // If the earliest order we can see is after the 1st, the window has clipped the month.
  return { orders, earliest, staleWindow: !!earliest && earliest > `${month}-01`, split };
}

/**
 * QB receipts in the period. Returns `ok` SEPARATELY from the map: "nothing received" and "the
 * query broke" are the same empty map, and conflating them is how a 9,652-unit bill went missing
 * and booked a $67,131 phantom gain.
 */
async function fetchReceived(workspaceId: string, month: string, admin: ReturnType<typeof createAdminClient>) {
  const last = String(lastDayOf(month)).padStart(2, "0");
  const byQbItem = new Map<string, number>();
  let ok = true;
  for (const entity of ["Bill", "Purchase"]) {
    try {
      const data = await qboFetch(workspaceId, "query", {
        query: { query: `SELECT * FROM ${entity} WHERE TxnDate >= '${month}-01' AND TxnDate <= '${month}-${last}' MAXRESULTS 1000` },
        admin,
      });
      for (const txn of data.QueryResponse?.[entity] ?? [])
        for (const line of txn.Line ?? []) {
          const d = line.ItemBasedExpenseLineDetail;
          if (!d?.ItemRef?.value || d.Qty === undefined) continue;
          const q = Number(d.Qty) || 0;
          if (q) byQbItem.set(String(d.ItemRef.value), (byQbItem.get(String(d.ItemRef.value)) ?? 0) + q);
        }
    } catch {
      ok = false;
    }
  }
  const { data: items } = await admin.from("qb_items").select("id, quickbooks_id").eq("workspace_id", workspaceId);
  const idByQbId = new Map((items ?? []).map((i) => [String(i.quickbooks_id), i.id]));
  const byProduct = new Map<string, number>();
  for (const [qbId, qty] of byQbItem) {
    const pid = idByQbId.get(qbId);
    if (pid) byProduct.set(pid, (byProduct.get(pid) ?? 0) + qty);
  }
  return { byProduct, ok };
}

/** Recent posted adjustment values — the guard's plausibility band. */
async function recentAdjustmentValues(
  workspaceId: string,
  admin: ReturnType<typeof createAdminClient>,
  month: string,
): Promise<number[]> {
  const { data } = await admin
    .from("qb_close_dry_runs")
    .select("adjustment_value, closing_month, passed")
    .eq("workspace_id", workspaceId)
    .neq("closing_month", month)
    .eq("passed", true)
    .order("ran_at", { ascending: false })
    .limit(6);
  return (data ?? []).map((r) => Number(r.adjustment_value)).filter((v) => Number.isFinite(v) && v > 0);
}

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get("month");
  if (!month || !MONTH_RE.test(month)) return NextResponse.json({ error: "month=YYYY-MM required" }, { status: 400 });
  const workspaceId = request.nextUrl.searchParams.get("workspace_id");
  if (!workspaceId) return NextResponse.json({ error: "workspace_id required" }, { status: 400 });

  const admin = createAdminClient();
  const eligibility = await assertPostable(admin, workspaceId, month);
  const { data: latest } = await admin
    .from("qb_close_dry_runs")
    .select("*")
    .eq("workspace_id", workspaceId).eq("closing_month", month)
    .order("ran_at", { ascending: false }).limit(1).maybeSingle();
  const { data: closing } = await admin
    .from("qb_month_end_closings")
    .select("*")
    .eq("workspace_id", workspaceId).eq("closing_month", month).maybeSingle();

  return NextResponse.json({ month, eligibility, latest_dry_run: latest ?? null, closing: closing ?? null });
}

/**
 * PATCH — override a processor's fees for the month, then rebuild the JournalEntry.
 *
 * Braintree's API only ever reports an ESTIMATE (~58%); card-network assessments post around the
 * 5th, so the real figure is known only from the statement and has to be entered by hand. Writing
 * it here updates `qb_payment_processor_summaries.processing_fees`, which changes both the
 * txn-fee debit and the clearing net-down credit on the next computation.
 *
 * If the month's JournalEntry is already posted, it is UPDATED IN PLACE (Id + SyncToken). That is
 * safe precisely because the JE is the one idempotent artifact — the InventoryAdjustment and the
 * SalesReceipts are not, and are deliberately untouched here.
 */
export async function PATCH(request: NextRequest) {
  let body: { month?: string; workspace_id?: string; processor?: string; processing_fees?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const { month, workspace_id: workspaceId, processor = "braintree", processing_fees: fees } = body;
  if (!month || !MONTH_RE.test(month)) return NextResponse.json({ error: "month (YYYY-MM) required" }, { status: 400 });
  if (!workspaceId) return NextResponse.json({ error: "workspace_id required" }, { status: 400 });
  if (typeof fees !== "number" || !Number.isFinite(fees) || fees < 0) {
    return NextResponse.json({ error: "processing_fees must be a non-negative number" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error: upErr } = await admin
    .from("qb_payment_processor_summaries")
    .update({ processing_fees: fees, synced_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId).eq("closing_month", month).eq("processor", processor);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // Rebuild the JE off the new figure so the caller sees the effect immediately.
  const { data: closing } = await admin
    .from("qb_month_end_closings")
    .select("shopify_journal_entry_id, shopify_journal_entry_doc, status")
    .eq("workspace_id", workspaceId).eq("closing_month", month).maybeSingle();

  let rebuilt: { debits: number; credits: number; balanced: boolean } | null = null;
  let reposted: string | null = null;
  try {
    const [shopify, received] = await Promise.all([
      fetchShopifyOrders(workspaceId, month),
      fetchReceived(workspaceId, month, admin),
    ]);
    const { buildMonthEndArtifacts } = await import("@/lib/qb-close/month-end");
    const art = await buildMonthEndArtifacts({
      workspaceId, month, admin, orders: shopify.orders, receivedByProduct: received.byProduct,
    });
    const diff = Math.round(Math.abs(art.journalEntry.totalDebits - art.journalEntry.totalCredits) * 100) / 100;
    rebuilt = { debits: art.journalEntry.totalDebits, credits: art.journalEntry.totalCredits, balanced: diff <= 0.01 };

    if (closing?.shopify_journal_entry_id && rebuilt.balanced) {
      // Update in place — QBO needs the CURRENT SyncToken, so read it back first.
      const existing = await qboFetch(workspaceId, `journalentry/${closing.shopify_journal_entry_id}`, { admin });
      const sync = existing?.JournalEntry?.SyncToken;
      if (sync !== undefined) {
        const res = await qboFetch(workspaceId, "journalentry", {
          method: "POST", admin,
          body: {
            Id: closing.shopify_journal_entry_id,
            SyncToken: sync,
            sparse: false,
            TxnDate: `${month}-${String(lastDayOf(month)).padStart(2, "0")}`,
            DocNumber: closing.shopify_journal_entry_doc,
            Line: art.journalEntry.lines.map((l) => ({
              DetailType: "JournalEntryLineDetail",
              Amount: Math.round(l.amount * 100) / 100,
              Description: l.description,
              JournalEntryLineDetail: { PostingType: l.posting, AccountRef: { value: l.accountId } },
            })),
          },
        });
        reposted = res?.JournalEntry?.Id ?? null;
      }
    }
  } catch (e) {
    return NextResponse.json(
      { ok: true, processor, processing_fees: fees, rebuilt, repost_error: (e as Error).message.slice(0, 300) },
      { status: 200 },
    );
  }

  return NextResponse.json({
    ok: true, month, processor, processing_fees: fees, rebuilt,
    journal_entry_updated: reposted,
    note: reposted
      ? "Posted JournalEntry updated in place."
      : closing?.shopify_journal_entry_id
        ? "Fee saved; the posted JE was NOT updated (it does not currently balance)."
        : "Fee saved. Re-run the dry run to see it reflected.",
  });
}

export async function POST(request: NextRequest) {
  let body: { month?: string; workspace_id?: string; post?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const { month, workspace_id: workspaceId, post } = body;
  if (!month || !MONTH_RE.test(month)) return NextResponse.json({ error: "month (YYYY-MM) required" }, { status: 400 });
  if (!workspaceId) return NextResponse.json({ error: "workspace_id required" }, { status: 400 });

  // The close may only run for an ELAPSED month — mid-month there is no period-end physical
  // snapshot to measure against.
  const [y, m] = month.split("-").map(Number);
  if (new Date() < new Date(y, m, 1)) {
    return NextResponse.json({ error: `${month} has not ended yet; the close runs after the 1st of the following month` }, { status: 400 });
  }

  const admin = createAdminClient();
  try {
    const [shopify, received, recent] = await Promise.all([
      fetchShopifyOrders(workspaceId, month),
      fetchReceived(workspaceId, month, admin),
      recentAdjustmentValues(workspaceId, admin, month),
    ]);

    const result = await runMonthEndClose({
      workspaceId, month, admin,
      orders: shopify.orders,
      receivedByProduct: received.byProduct,
      receiptsLookupOk: received.ok,
      mode: post ? "post" : "shadow",
      recentAdjustmentValues: recent,
    });

    const warnings: string[] = [];
    if (shopify.split.failed) {
      warnings.push(
        `${shopify.split.failed} split-payment order(s) fell back to an EQUAL gateway split because their ` +
          `transactions could not be read — their clearing debits are approximate.`,
      );
    }
    if (shopify.staleWindow) {
      warnings.push(
        `Shopify returned no orders before ${shopify.earliest} for ${month}. The Admin API caps at ~60 trailing days ` +
          `without the read_all_orders scope, so this month's revenue is UNDER-REPORTED and the JE will still balance. ` +
          `Grant read_all_orders or close within 60 days of month start.`,
      );
    }

    return NextResponse.json(
      {
        month: result.month,
        mode: result.mode,
        refused: result.refused ?? null,
        guard: { passed: result.assessment.passed, blocking: result.assessment.blocking, warnings: result.assessment.warnings },
        steps: result.steps,
        closing_id: result.closingId ?? null,
        summary: {
          je_lines: result.artifacts.journalEntry.lines.length,
          je_debits: result.artifacts.journalEntry.totalDebits,
          je_credits: result.artifacts.journalEntry.totalCredits,
          adjustment_lines: result.artifacts.inventoryAdjustment.length,
          receipt_units: {
            amazon: result.artifacts.receipts.amazon.reduce((a, l) => a + l.qty, 0),
            shopify: result.artifacts.receipts.shopify.reduce((a, l) => a + l.qty, 0),
            internal: result.artifacts.receipts.internal.reduce((a, l) => a + l.qty, 0),
          },
          shopify_orders: shopify.orders.length,
          split_payment_orders_resolved: shopify.split.resolved,
          gateway_reallocation: shopify.split.correction,
        },
        warnings,
      },
      { status: result.refused ? 409 : 200 },
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
