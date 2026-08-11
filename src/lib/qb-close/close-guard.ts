/**
 * qb-close/close-guard — decides whether a month-end close may POST, and grades a dry run.
 *
 * The month-end close is largely irreversible: the JournalEntry is idempotent (updated in place
 * by stored id + SyncToken) but the InventoryAdjustment and the three SalesReceipts are NOT —
 * no void, no dedup — so a second run duplicates real QuickBooks documents and corrupts
 * inventory. Everything here exists to make posting twice, or posting off bad inputs,
 * structurally impossible rather than merely discouraged.
 *
 * Two independent gates:
 *   1. RUN-ONCE  — no completed `qb_month_end_closings` row for the month. The
 *      `(workspace_id, closing_month)` UNIQUE is the schema backstop; this is the polite refusal.
 *   2. DRY-RUN-PROVEN — the latest `qb_close_dry_runs` row for the month must have `passed`.
 *
 * ⭐ The failure mode this is really built for is not a crash — it is a **silently degraded
 * input** producing a confident, balanced, wrong close. In July 2026 a dead QuickBooks
 * connection made the receipts lookup return "0 received" for all 56 items behind a bare
 * `catch {}`, which alone booked a $67,131 phantom gain. `assessDryRun` therefore grades INPUT
 * HEALTH as hard blockers, not warnings.
 *
 * See docs/brain/libraries/qb-close-guard.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MonthEndArtifacts } from "./month-end";

/** A reason a close may not post. `code` is stable for tests + UI; `detail` is human-facing. */
export interface BlockingIssue {
  code:
    | "empty_opening_book"
    | "missing_processor_summaries"
    | "receipts_lookup_unavailable"
    | "je_out_of_balance"
    | "no_physical_snapshot"
    | "stale_physical_snapshot"
    | "adjustment_implausible";
  detail: string;
}

export interface DryRunAssessment {
  passed: boolean;
  blocking: BlockingIssue[];
  warnings: string[];
  jeBalanced: boolean;
  inputHealth: Record<string, unknown>;
}

/** QuickBooks rejects a JournalEntry whose debits and credits differ by more than a cent. */
export const JE_BALANCE_TOLERANCE = 0.01;

/**
 * Expected processors. A month missing one silently drops its whole fee/refund/chargeback/
 * clearing block from the JE — which then cannot balance.
 */
export const REQUIRED_PROCESSORS = ["shopify_payments", "paypal", "braintree"] as const;

export interface AssessDryRunInput {
  artifacts: MonthEndArtifacts;
  /** processors present in `qb_payment_processor_summaries` for the month */
  processorsPresent: string[];
  /** Whether the QB receipts query actually SUCCEEDED. `false` ≠ "nothing received". */
  receiptsLookupOk: boolean;
  /** last day of the closing month, `YYYY-MM-DD` — physical snapshots should land on it */
  periodEnd: string;
  /** Σ |QtyDiff| × unit_cost, for the plausibility band. */
  adjustmentValue: number | null;
  /** Recent posted adjustment values, for the plausibility band (most recent first). */
  recentAdjustmentValues?: number[];
}

/**
 * Grade a dry run. Returns the verdict + every reason it cannot post.
 *
 * Deliberately conservative: an input we cannot VERIFY is treated as failed, never as zero.
 * "No receipts this month" and "the receipts query broke" look identical downstream, and the
 * second one is how July lost a 9,652-unit bill.
 */
export function assessDryRun(inp: AssessDryRunInput): DryRunAssessment {
  const { artifacts: a, processorsPresent, receiptsLookupOk, periodEnd, adjustmentValue } = inp;
  const blocking: BlockingIssue[] = [];
  const warnings: string[] = [];

  // ── opening book ──
  if (!a.meta.qbBasisRows) {
    blocking.push({
      code: "empty_opening_book",
      detail:
        `No ${a.meta.priorMonth} month_end_post rows — the opening book is empty. This does not error: ` +
        `every item computes as a total loss (an early ShopCX run produced a 1,097,674-unit adjustment this way).`,
    });
  }

  // ── processor rollups ──
  const missing = REQUIRED_PROCESSORS.filter((p) => !processorsPresent.includes(p));
  if (missing.length) {
    blocking.push({
      code: "missing_processor_summaries",
      detail: `qb_payment_processor_summaries is missing ${missing.join(", ")} for ${a.month}; the JE will omit that block and cannot balance.`,
    });
  }

  // ── receipts lookup ──
  if (!receiptsLookupOk) {
    blocking.push({
      code: "receipts_lookup_unavailable",
      detail:
        "The QuickBooks receipts query did not succeed, so `received` is unverified. An unverified receipts term " +
        "reads as zero and inflates every variance into a phantom gain — do not treat it as 'nothing was received'.",
    });
  } else if (!a.meta.receivedItemCount) {
    warnings.push("Receipts query succeeded but returned no items — genuinely no inventory received this month.");
  }

  // ── physical snapshots ──
  for (const [label, date] of [
    ["FBA", a.meta.fbaSnapshotDate],
    ["3PL", a.meta.tplSnapshotDate],
  ] as const) {
    if (!date) {
      blocking.push({ code: "no_physical_snapshot", detail: `No ${label} inventory snapshot on or before ${periodEnd}.` });
    } else if (date !== periodEnd) {
      blocking.push({
        code: "stale_physical_snapshot",
        detail: `${label} snapshot is ${date}, not period end ${periodEnd} — physical would be measured on the wrong day.`,
      });
    }
  }

  // ── journal entry balance ──
  // Round to cents BEFORE comparing: raw float subtraction makes an exactly-at-tolerance JE
  // read as 0.010000000000005 and fail, rejecting a close QuickBooks would have accepted.
  const jeDiff = Math.round(Math.abs(a.journalEntry.totalDebits - a.journalEntry.totalCredits) * 100) / 100;
  const jeBalanced = jeDiff <= JE_BALANCE_TOLERANCE;
  if (!jeBalanced) {
    blocking.push({
      code: "je_out_of_balance",
      detail:
        `JournalEntry is out of balance by $${jeDiff.toFixed(2)} (tolerance $${JE_BALANCE_TOLERANCE.toFixed(2)}); ` +
        `QuickBooks will reject the post. A dropped internal order line is the usual cause.`,
    });
  }

  // ── adjustment plausibility ──
  // Not a correctness proof — a tripwire. July's first run computed $85,864 against a $2-3K
  // run-rate and none of it was real shrinkage.
  const recent = (inp.recentAdjustmentValues ?? []).filter((v) => Number.isFinite(v) && v > 0);
  if (adjustmentValue != null && recent.length) {
    const band = Math.max(...recent) * 3;
    if (adjustmentValue > band) {
      blocking.push({
        code: "adjustment_implausible",
        detail:
          `Inventory adjustment $${adjustmentValue.toFixed(2)} exceeds 3× the recent maximum ` +
          `($${Math.max(...recent).toFixed(2)}). Investigate inputs before posting — an outsized adjustment has ` +
          `so far always been bad inputs, not real shrinkage.`,
      });
    }
  }

  if (a.journalEntry.warnings.length) warnings.push(...a.journalEntry.warnings);

  return {
    passed: blocking.length === 0,
    blocking,
    warnings,
    jeBalanced,
    inputHealth: {
      opening_book_rows: a.meta.qbBasisRows,
      prior_month: a.meta.priorMonth,
      processor_count: processorsPresent.length,
      processors_present: processorsPresent,
      receipts_lookup_ok: receiptsLookupOk,
      received_items: a.meta.receivedItemCount,
      fba_snapshot_date: a.meta.fbaSnapshotDate,
      tpl_snapshot_date: a.meta.tplSnapshotDate,
      shopify_order_count: a.meta.shopifyOrderCount,
    },
  };
}

export interface PostEligibility {
  allowed: boolean;
  reason?: string;
  /** ISO timestamp of the dry run that authorised this post. */
  provenAt?: string;
}

/**
 * May `month` post? Checks run-once first (the cheaper, more dangerous condition), then
 * dry-run-proven. Read-only — callers must still hold the write path behind this.
 */
export async function assertPostable(
  admin: SupabaseClient,
  workspaceId: string,
  month: string,
): Promise<PostEligibility> {
  const { data: existing, error: closeErr } = await admin
    .from("qb_month_end_closings")
    .select("id, status, completed_at")
    .eq("workspace_id", workspaceId)
    .eq("closing_month", month)
    .maybeSingle();
  if (closeErr) return { allowed: false, reason: `could not read qb_month_end_closings: ${closeErr.message}` };

  if (existing && (existing.status === "completed" || existing.status === "completed_with_errors")) {
    return {
      allowed: false,
      reason:
        `${month} is already closed (status ${existing.status}${existing.completed_at ? `, ${existing.completed_at}` : ""}). ` +
        `Re-posting would duplicate the InventoryAdjustment and SalesReceipts — those are not idempotent.`,
    };
  }

  const { data: dry, error: dryErr } = await admin
    .from("qb_close_dry_runs")
    .select("passed, ran_at, blocking_issues")
    .eq("workspace_id", workspaceId)
    .eq("closing_month", month)
    .order("ran_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (dryErr) return { allowed: false, reason: `could not read qb_close_dry_runs: ${dryErr.message}` };

  if (!dry) return { allowed: false, reason: `no dry run recorded for ${month} — run the shadow close first.` };
  if (!dry.passed) {
    const codes = Array.isArray(dry.blocking_issues)
      ? (dry.blocking_issues as { code?: string }[]).map((b) => b?.code).filter(Boolean).join(", ")
      : "";
    return {
      allowed: false,
      reason: `the latest ${month} dry run (${dry.ran_at}) did not pass${codes ? `: ${codes}` : ""}.`,
    };
  }

  return { allowed: true, provenAt: dry.ran_at as string };
}

/** Persist a dry-run verdict. The ledger is append-only — never update a prior row. */
export async function recordDryRun(
  admin: SupabaseClient,
  workspaceId: string,
  artifacts: MonthEndArtifacts,
  assessment: DryRunAssessment,
  adjustmentValue: number | null,
): Promise<void> {
  const absUnits = artifacts.inventoryAdjustment.reduce((a, l) => a + Math.abs(l.qtyDiff), 0);
  const units = (ls: { qty: number }[]) => ls.reduce((a, l) => a + l.qty, 0);
  const { error } = await admin.from("qb_close_dry_runs").insert({
    workspace_id: workspaceId,
    closing_month: artifacts.month,
    passed: assessment.passed,
    blocking_issues: assessment.blocking,
    warnings: assessment.warnings,
    je_balanced: assessment.jeBalanced,
    je_total_debits: artifacts.journalEntry.totalDebits,
    je_total_credits: artifacts.journalEntry.totalCredits,
    je_line_count: artifacts.journalEntry.lines.length,
    adjustment_line_count: artifacts.inventoryAdjustment.length,
    adjustment_abs_units: absUnits,
    adjustment_value: adjustmentValue,
    receipt_units: {
      amazon: units(artifacts.receipts.amazon),
      shopify: units(artifacts.receipts.shopify),
      internal: units(artifacts.receipts.internal),
    },
    input_health: assessment.inputHealth,
  });
  if (error) throw new Error(`recordDryRun: ${error.message}`);
}
