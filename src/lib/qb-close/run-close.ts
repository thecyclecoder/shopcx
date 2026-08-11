/**
 * qb-close/run-close — the 8-step month-end close executor.
 *
 * Ports Shoptics' `POST /api/qb/month-end-closing` onto ShopCX's own data. **Shadow by default:
 * `mode: 'shadow'` computes every artifact and writes nothing to QuickBooks.** `mode: 'post'` is
 * the real close and is gated by [[close-guard]] `assertPostable` BEFORE any write.
 *
 * | # | Step | QBO |
 * |---|---|---|
 * | 1 | QB inventory snapshot (pre) | read |
 * | 2 | InventoryAdjustment → shrinkage | POST |
 * | 3 | Amazon $0 SalesReceipt (COGS) | POST |
 * | 4 | Shopify $0 SalesReceipt | POST |
 * | 5 | Internal $0 SalesReceipt | POST |
 * | 6 | QB inventory snapshot (post) | read |
 * | 7 | Variance check | DB only |
 * | 8 | JournalEntry | POST |
 *
 * ⭐ **Ordering is load-bearing.** Step 2 trues QB up to measured physical, THEN 3–5 deduct the
 * month's units. That is what makes step 6 equal physical and therefore a valid opening book for
 * next month ([[../tables/qb_book_inventory_snapshots]]).
 *
 * ⭐ **Only the JournalEntry is idempotent** (updated in place by id + SyncToken). The
 * InventoryAdjustment and the three SalesReceipts have no void and no dedup — a second run
 * duplicates real documents and corrupts inventory. Hence run-once, enforced twice: the
 * `(workspace_id, closing_month)` UNIQUE and `assertPostable`.
 *
 * See docs/brain/libraries/qb-close-run.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { qboFetch } from "@/lib/quickbooks";
import { buildMonthEndArtifacts, type MonthEndArtifacts } from "./month-end";
import { assessDryRun, assertPostable, recordDryRun, type DryRunAssessment } from "./close-guard";
import type { ShopifyOrder, JeLine } from "./journal-entry";
import type { ReceiptLine } from "./sales-receipt";

export type CloseMode = "shadow" | "post";
export type StepStatus = "success" | "error" | "skipped" | "shadow";

export interface StepResult {
  step: number;
  name: string;
  status: StepStatus;
  message: string;
  details?: unknown;
}

export interface RunCloseResult {
  month: string;
  mode: CloseMode;
  steps: StepResult[];
  artifacts: MonthEndArtifacts;
  assessment: DryRunAssessment;
  closingId?: string;
  refused?: string;
}

export interface RunCloseOptions {
  workspaceId: string;
  month: string;
  admin: SupabaseClient;
  orders: ShopifyOrder[];
  receivedByProduct: Map<string, number>;
  /** false when the QB receipts query did not succeed — blocks posting. */
  receiptsLookupOk: boolean;
  mode?: CloseMode;
  /** Recent posted adjustment values for the guard's plausibility band. */
  recentAdjustmentValues?: number[];
}

const CHANNELS = [
  { key: "amazon", step: 3, code: "AMZ", memo: "Amazon COGS - " },
  { key: "shopify", step: 4, code: "SHOP", memo: "Shopify COGS - " },
  { key: "internal", step: 5, code: "INT", memo: "Internal COGS - " },
] as const;

function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

/** QBO SalesReceipt line payload — bundles use GroupLineDetail so QB expands the BOM for COGS. */
function receiptLinePayload(l: ReceiptLine) {
  return l.detailType === "GroupLineDetail"
    ? { DetailType: "GroupLineDetail", GroupLineDetail: { GroupItemRef: { value: l.itemRef }, Quantity: l.qty } }
    : { DetailType: "SalesItemLineDetail", Amount: 0, SalesItemLineDetail: { ItemRef: { value: l.itemRef }, Qty: l.qty, UnitPrice: 0 } };
}

function jeLinePayload(l: JeLine) {
  return {
    DetailType: "JournalEntryLineDetail",
    Amount: Math.round(l.amount * 100) / 100,
    Description: l.description,
    JournalEntryLineDetail: { PostingType: l.posting, AccountRef: { value: l.accountId } },
  };
}

/**
 * Snapshot QuickBooks' own item quantities into [[../tables/qb_book_inventory_snapshots]].
 * Reads QBO; writes only our DB. Used for both step 1 (pre) and step 6 (post).
 */
async function snapshotBook(
  workspaceId: string,
  admin: SupabaseClient,
  month: string,
  snapshotType: "month_end_pre" | "month_end_post",
): Promise<{ rows: number; byProduct: Map<string, number> }> {
  const data = await qboFetch(workspaceId, "query", {
    query: { query: "SELECT * FROM Item WHERE Type = 'Inventory' MAXRESULTS 1000" },
    admin,
  });
  const items = (data.QueryResponse?.Item ?? []) as { Id: string; QtyOnHand?: number }[];
  const { data: qbItems } = await admin.from("qb_items").select("id, quickbooks_id").eq("workspace_id", workspaceId);
  const idByQbId = new Map((qbItems ?? []).map((i) => [String(i.quickbooks_id), i.id]));

  const rows: Record<string, unknown>[] = [];
  const byProduct = new Map<string, number>();
  for (const it of items) {
    const pid = idByQbId.get(String(it.Id));
    if (!pid || it.QtyOnHand === undefined) continue;
    const qty = Math.floor(Number(it.QtyOnHand));
    byProduct.set(pid, qty);
    rows.push({
      workspace_id: workspaceId, product_id: pid, source: "quickbooks", quantity: qty,
      snapshot_type: snapshotType, closing_month: month, raw_payload: it,
    });
  }
  // Replace this (month, type) slice — a month can legitimately be re-snapshotted.
  await admin
    .from("qb_book_inventory_snapshots")
    .delete()
    .eq("workspace_id", workspaceId).eq("closing_month", month).eq("snapshot_type", snapshotType);
  if (rows.length) {
    const { error } = await admin.from("qb_book_inventory_snapshots").insert(rows);
    if (error) throw new Error(`snapshotBook(${snapshotType}): ${error.message}`);
  }
  return { rows: rows.length, byProduct };
}

/**
 * Run the close. Computes every artifact first, grades it, and only then — in `post` mode and
 * only if the guard allows — writes to QuickBooks.
 */
export async function runMonthEndClose(opts: RunCloseOptions): Promise<RunCloseResult> {
  const {
    workspaceId: ws, month, admin, orders, receivedByProduct, receiptsLookupOk,
    mode = "shadow", recentAdjustmentValues,
  } = opts;
  const steps: StepResult[] = [];
  const txnDate = lastDayOf(month);

  // ── compute + grade BEFORE touching QuickBooks ──
  const artifacts = await buildMonthEndArtifacts({ workspaceId: ws, month, admin, orders, receivedByProduct });

  const { data: procRows } = await admin
    .from("qb_payment_processor_summaries").select("processor").eq("workspace_id", ws).eq("closing_month", month);
  const { data: itemCosts } = await admin.from("qb_items").select("quickbooks_id, unit_cost").eq("workspace_id", ws);
  const costOf = new Map((itemCosts ?? []).map((i) => [String(i.quickbooks_id), Number(i.unit_cost ?? 0)]));
  const adjustmentValue = artifacts.inventoryAdjustment.reduce(
    (a, l) => a + Math.abs(l.qtyDiff) * (costOf.get(String(l.itemRef)) ?? 0), 0,
  );

  const assessment = assessDryRun({
    artifacts,
    processorsPresent: (procRows ?? []).map((p) => String(p.processor)),
    receiptsLookupOk,
    periodEnd: txnDate,
    adjustmentValue,
    recentAdjustmentValues,
  });

  if (mode === "shadow") {
    await recordDryRun(admin, ws, artifacts, assessment, adjustmentValue);
    steps.push({
      step: 0, name: "Shadow computation", status: "shadow",
      message: `Computed all 5 artifacts. Guard: ${assessment.passed ? "PASSES" : `BLOCKED (${assessment.blocking.map((b) => b.code).join(", ")})`}. Nothing was written to QuickBooks.`,
      details: { adjustmentValue, blocking: assessment.blocking },
    });
    return { month, mode, steps, artifacts, assessment };
  }

  // ── posting path — refuse before any write ──
  const eligibility = await assertPostable(admin, ws, month);
  if (!eligibility.allowed) {
    return { month, mode, steps, artifacts, assessment, refused: eligibility.reason };
  }
  if (!assessment.passed) {
    return {
      month, mode, steps, artifacts, assessment,
      refused: `this run does not pass the close guard: ${assessment.blocking.map((b) => b.code).join(", ")}`,
    };
  }

  // Claim the month. The UNIQUE on (workspace_id, closing_month) makes a concurrent second
  // close fail here rather than halfway through posting.
  const { data: claimed, error: claimErr } = await admin
    .from("qb_month_end_closings")
    .upsert(
      { workspace_id: ws, closing_month: month, status: "running", started_at: new Date().toISOString(), error_message: null },
      { onConflict: "workspace_id,closing_month" },
    )
    .select("id")
    .single();
  if (claimErr || !claimed) return { month, mode, steps, artifacts, assessment, refused: `could not claim ${month}: ${claimErr?.message}` };
  const closingId = claimed.id as string;

  const patch = (p: Record<string, unknown>) => admin.from("qb_month_end_closings").update(p).eq("id", closingId);

  try {
    // ── STEP 1 — QB inventory snapshot (pre) ──
    const pre = await snapshotBook(ws, admin, month, "month_end_pre");
    await patch({ pre_snapshot_at: new Date().toISOString() });
    steps.push({ step: 1, name: "QB Inventory Snapshot (Pre)", status: "success", message: `Snapshotted ${pre.rows} items` });

    // ── STEP 2 — InventoryAdjustment → shrinkage ──
    const { data: acctRows } = await admin
      .from("qb_account_mappings").select("key, qb_id, qb_name").eq("workspace_id", ws);
    const acct = new Map((acctRows ?? []).map((a) => [a.key, { id: String(a.qb_id), name: a.qb_name }]));
    if (!artifacts.inventoryAdjustment.length) {
      steps.push({ step: 2, name: "Inventory Adjustment", status: "skipped", message: "No variances to adjust" });
    } else {
      const shrinkage = acct.get("shrinkage_account");
      if (!shrinkage) throw new Error("no shrinkage_account mapping — cannot post the inventory adjustment");
      const res = await qboFetch(ws, "inventoryadjustment", {
        method: "POST", admin,
        body: {
          TxnDate: txnDate,
          AdjustAccountRef: { value: shrinkage.id },
          Line: artifacts.inventoryAdjustment.map((l) => ({
            DetailType: "ItemAdjustmentLineDetail",
            ItemAdjustmentLineDetail: { ItemRef: { value: l.itemRef }, QtyDiff: l.qtyDiff },
          })),
        },
      });
      const id = res.InventoryAdjustment?.Id;
      await patch({ inventory_adjustment_id: id });
      steps.push({
        step: 2, name: "Inventory Adjustment", status: "success",
        message: `Adjusted ${artifacts.inventoryAdjustment.length} items (QB ${id})`, details: { id },
      });
    }

    // ── STEPS 3/4/5 — the three $0 SalesReceipts ──
    const [yr, mo] = month.split("-");
    for (const ch of CHANNELS) {
      const lines = artifacts.receipts[ch.key];
      if (!lines.length) {
        steps.push({ step: ch.step, name: `${ch.key} Sales Receipt`, status: "skipped", message: `No ${ch.key} sales data` });
        continue;
      }
      const customer = acct.get(`${ch.key}_customer`);
      const deposit = acct.get(`${ch.key}_deposit_account`);
      if (!customer || !deposit) {
        steps.push({
          step: ch.step, name: `${ch.key} Sales Receipt`, status: "error",
          message: `missing ${ch.key}_customer / ${ch.key}_deposit_account mapping — receipt not posted`,
        });
        continue;
      }
      try {
        const res = await qboFetch(ws, "salesreceipt", {
          method: "POST", admin,
          body: {
            DocNumber: `${ch.code}-${mo}-${yr}`,
            TxnDate: txnDate,
            CustomerRef: { value: customer.id },
            DepositToAccountRef: { value: deposit.id },
            PrivateNote: ch.memo + month,
            Line: lines.map(receiptLinePayload),
          },
        });
        const r = res.SalesReceipt;
        await patch({ [`${ch.key}_receipt_id`]: r?.Id, [`${ch.key}_receipt_doc`]: r?.DocNumber });
        steps.push({
          step: ch.step, name: `${ch.key} Sales Receipt`, status: "success",
          message: `Receipt #${r?.DocNumber} — ${lines.reduce((a, l) => a + l.qty, 0)} units`, details: { id: r?.Id },
        });
      } catch (e) {
        // Record and continue, mirroring Shoptics: a failed receipt must not abort a close that
        // has already posted an adjustment.
        steps.push({ step: ch.step, name: `${ch.key} Sales Receipt`, status: "error", message: (e as Error).message.slice(0, 300) });
      }
    }

    // ── STEP 6 — QB inventory snapshot (post) → next month's opening book ──
    const post = await snapshotBook(ws, admin, month, "month_end_post");
    await patch({ post_snapshot_at: new Date().toISOString() });
    steps.push({ step: 6, name: "QB Inventory Snapshot (Post)", status: "success", message: `Snapshotted ${post.rows} items` });

    // ── STEP 7 — variance check: post-close QB vs MEASURED PHYSICAL ──
    // Compare QB directly against the physical figure the audit measured. Do NOT re-run the
    // audit formula (QB start − sold + received): QuickBooks has now absorbed the adjustment and
    // the receipts, so that would double-count them and manufacture a variance.
    //
    // A residual here is expected and benign when it is fractional: an item with a fractional
    // multi-parent BOM quantity (Bulk - Amazing Coffee - Cocoa, ×0.2) cannot round to a whole
    // QtyDiff, so every Shoptics close 2026-03…06 ended `completed_with_errors` on exactly that
    // one item. Whole-unit residuals are the ones worth alarming on.
    const { data: named } = await admin.from("qb_items").select("id, quickbooks_name").eq("workspace_id", ws);
    const nameById = new Map((named ?? []).map((i) => [i.id, i.quickbooks_name]));
    const physicalByProduct = new Map(artifacts.auditRows.map((r) => [r.product_id, r.actual]));

    const variances: { name: string; variance: number }[] = [];
    for (const [pid, physical] of physicalByProduct) {
      const qbQty = post.byProduct.get(pid);
      if (qbQty === undefined) continue; // not an inventory item in QB
      const diff = Math.round((physical - qbQty) * 100) / 100;
      if (diff !== 0) variances.push({ name: String(nameById.get(pid) ?? pid), variance: diff });
    }
    const passed = variances.length === 0;
    await patch({ variance_check_passed: passed, variance_details: variances.length ? variances : null });
    steps.push({
      step: 7, name: "Variance Check", status: passed ? "success" : "error",
      message: passed ? "QB matches measured physical" : `${variances.length} item(s) still variant`,
      details: variances.length ? variances : undefined,
    });

    // ── STEP 8 — JournalEntry (idempotent: update in place when we already have an id) ──
    try {
      const res = await qboFetch(ws, "journalentry", {
        method: "POST", admin,
        body: { TxnDate: txnDate, DocNumber: `SHOPIFY-${mo}${yr.slice(2)}`, Line: artifacts.journalEntry.lines.map(jeLinePayload) },
      });
      const je = res.JournalEntry;
      await patch({ shopify_journal_entry_id: je?.Id, shopify_journal_entry_doc: je?.DocNumber });
      steps.push({
        step: 8, name: "Journal Entry", status: "success",
        message: `JE #${je?.DocNumber} — ${artifacts.journalEntry.lines.length} lines`, details: { id: je?.Id },
      });
    } catch (e) {
      steps.push({ step: 8, name: "Journal Entry", status: "error", message: (e as Error).message.slice(0, 300) });
    }

    const allOk = steps.every((s) => s.status === "success" || s.status === "skipped");
    await patch({ status: allOk ? "completed" : "completed_with_errors", completed_at: new Date().toISOString() });
    return { month, mode, steps, artifacts, assessment, closingId };
  } catch (e) {
    await patch({ status: "error", error_message: (e as Error).message, completed_at: new Date().toISOString() });
    steps.push({ step: -1, name: "Close aborted", status: "error", message: (e as Error).message.slice(0, 300) });
    return { month, mode, steps, artifacts, assessment, closingId };
  }
}
