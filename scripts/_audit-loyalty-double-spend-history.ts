/**
 * Phase 3 backfill audit for the loyalty coupon-apply double-spend
 * (spec: loyalty-coupon-apply-self-heal-must-not-double-deduct-points).
 *
 * READ-ONLY. Sizes historical over-deductions produced by the (now-fixed)
 * regen branch inside apply_loyalty_coupon (src/lib/action-executor.ts).
 * The Phase-2 fix in `claimRegenSpendSlot` stops it going forward — this
 * script surfaces the past damage so the founder can decide, per member,
 * whether to hand-correct (as Susan D. was already corrected on
 * 2026-07-09).
 *
 * FOUNDER-GATED. This script is a REPORT, not a remedy. It writes NOTHING
 * — no `addPoints`, no `spendPoints`, no `loyalty_transactions.insert`,
 * no `loyalty_members.update`. Any correction is a separate, human-
 * approved step per member.
 *
 * ── Fingerprint ─────────────────────────────────────────────────────
 *
 * Susan's ledger shows two "-1500 / Redeemed $X Off (regenerated)"
 * spending rows within ~12 seconds on 2026-07-09; the same pattern is
 * visible ×3 on 2026-06-11 and ×2 on 2026-06-25. That is the durable
 * signature of the regen branch re-firing for one applied coupon:
 *
 *   type          = 'spending'
 *   description   LIKE 'Redeemed % (regenerated)'
 *   two-or-more rows for the SAME (workspace_id, member_id) within a
 *   short window (default 60s) whose points_change are all -N for the
 *   same N.
 *
 * Any such cluster represents one applied coupon and two-or-more spends.
 * Over-deduction = (cluster.size − 1) × |points_change|.
 *
 * ── How to run ──────────────────────────────────────────────────────
 *
 *   npx tsx scripts/_audit-loyalty-double-spend-history.ts
 *     [--window-seconds 60]    tune the same-apply window (default 60)
 *     [--json]                 emit a machine-readable JSON report
 *     [--workspace-id <uuid>]  restrict to one workspace
 *
 * Output includes:
 *   - Per-member cluster list (created_at range + rows + total over-ded)
 *   - Susan (member aa8fe19e, ticket d19c2192) called out as
 *     ALREADY CORRECTED — she is expected to appear in the raw cluster
 *     list but should not be included in any refund plan.
 *
 * NO MUTATIONS. Grep the script for `.insert(`, `.update(`, `addPoints`,
 * `spendPoints` — all zero. The unit test
 * `scripts/_audit-loyalty-double-spend-history.test.ts` also asserts
 * this invariant.
 */
import { loadEnv, createAdminClient } from "./_bootstrap";

/** Susan D. — corrected by hand on d19c2192; excluded from any refund plan. */
const SUSAN_MEMBER_ID = "aa8fe19e";
const SUSAN_TICKET_ID = "d19c2192";

type SpendRow = {
  id: string;
  workspace_id: string;
  member_id: string;
  points_change: number;
  description: string;
  created_at: string;
  shopify_discount_id: string | null;
};

export type OverDeductCluster = {
  workspace_id: string;
  member_id: string;
  points_change: number;    // the negative value shared across the cluster
  row_ids: string[];        // ordered by created_at asc
  window_seconds: number;   // (last - first) in seconds
  first_created_at: string;
  last_created_at: string;
  duplicate_count: number;  // rows.length - 1 (the extra spends)
  over_deducted_points: number;  // (rows.length - 1) * |points_change|
};

/**
 * Pure clustering predicate. Given ordered spend rows (asc by created_at
 * per member), group into clusters where consecutive rows for the SAME
 * (workspace_id, member_id, points_change) fall within `windowSeconds`.
 *
 * Exported for the unit test — this is where the durable "same apply"
 * definition lives.
 */
export function clusterOverDeductions(
  rows: SpendRow[],
  windowSeconds: number,
): OverDeductCluster[] {
  // Sort defensively — the DB query orders by member_id then created_at
  // asc, but re-sort here so the pure function is order-independent.
  const sorted = [...rows].sort((a, b) => {
    if (a.workspace_id !== b.workspace_id) return a.workspace_id < b.workspace_id ? -1 : 1;
    if (a.member_id !== b.member_id) return a.member_id < b.member_id ? -1 : 1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return 0;
  });

  const clusters: OverDeductCluster[] = [];
  let current: SpendRow[] = [];

  const flush = () => {
    if (current.length < 2) { current = []; return }
    const first = current[0]!;
    const last = current[current.length - 1]!;
    const dtMs = new Date(last.created_at).getTime() - new Date(first.created_at).getTime();
    clusters.push({
      workspace_id: first.workspace_id,
      member_id: first.member_id,
      points_change: first.points_change,
      row_ids: current.map((r) => r.id),
      window_seconds: Math.round(dtMs / 1000),
      first_created_at: first.created_at,
      last_created_at: last.created_at,
      duplicate_count: current.length - 1,
      over_deducted_points: (current.length - 1) * Math.abs(first.points_change),
    });
    current = [];
  };

  for (const row of sorted) {
    if (current.length === 0) { current = [row]; continue }
    const prev = current[current.length - 1]!;
    const sameMember = prev.workspace_id === row.workspace_id && prev.member_id === row.member_id;
    const sameSpend = prev.points_change === row.points_change;
    const dtMs = new Date(row.created_at).getTime() - new Date(prev.created_at).getTime();
    if (sameMember && sameSpend && dtMs >= 0 && dtMs <= windowSeconds * 1000) {
      current.push(row);
    } else {
      flush();
      current = [row];
    }
  }
  flush();
  return clusters;
}

function parseArgs(argv: string[]): { windowSeconds: number; json: boolean; workspaceId: string | null } {
  let windowSeconds = 60;
  let json = false;
  let workspaceId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--window-seconds") { windowSeconds = Number(argv[++i]) || 60 }
    else if (a === "--json") { json = true }
    else if (a === "--workspace-id") { workspaceId = argv[++i] ?? null }
  }
  return { windowSeconds, json, workspaceId };
}

async function main(): Promise<void> {
  const { windowSeconds, json, workspaceId } = parseArgs(process.argv.slice(2));
  loadEnv();
  const admin = createAdminClient();

  // READ-ONLY: a single SELECT over the ledger, filtered to the
  // "(regenerated)" fingerprint the regen branch stamps. No writes.
  let q = admin
    .from("loyalty_transactions")
    .select("id, workspace_id, member_id, points_change, description, created_at, shopify_discount_id")
    .eq("type", "spending")
    .like("description", "Redeemed % (regenerated)")
    .order("workspace_id", { ascending: true })
    .order("member_id", { ascending: true })
    .order("created_at", { ascending: true });
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  const { data, error } = await q;
  if (error) throw error;

  const rows = (data ?? []) as SpendRow[];
  const clusters = clusterOverDeductions(rows, windowSeconds);

  const totalOverDeducted = clusters.reduce((s, c) => s + c.over_deducted_points, 0);
  const affectedMembers = new Set(clusters.map((c) => c.member_id)).size;
  const susanClusters = clusters.filter((c) => c.member_id.startsWith(SUSAN_MEMBER_ID));

  if (json) {
    console.log(JSON.stringify({
      generated_by: "_audit-loyalty-double-spend-history.ts",
      window_seconds: windowSeconds,
      workspace_id: workspaceId,
      rows_scanned: rows.length,
      clusters,
      totals: {
        clusters: clusters.length,
        affected_members: affectedMembers,
        over_deducted_points: totalOverDeducted,
      },
      already_corrected: {
        note: `Susan D. (member ${SUSAN_MEMBER_ID}, ticket ${SUSAN_TICKET_ID}) was corrected by hand on 2026-07-09; exclude from any refund plan.`,
        susan_cluster_count: susanClusters.length,
      },
      refund_plan: null,
    }, null, 2));
    return;
  }

  console.log("");
  console.log("── Loyalty double-spend audit ─────────────────────────────");
  console.log(`  window_seconds : ${windowSeconds}`);
  console.log(`  workspace      : ${workspaceId ?? "(all)"}`);
  console.log(`  rows scanned   : ${rows.length}`);
  console.log(`  clusters       : ${clusters.length}`);
  console.log(`  affected members: ${affectedMembers}`);
  console.log(`  over-deducted  : ${totalOverDeducted.toLocaleString()} pts`);
  console.log("");

  if (clusters.length === 0) {
    console.log("(No over-deduction clusters found.)");
  } else {
    console.log("Cluster breakdown (member  |  dup×|pts|  |  window  |  first → last)");
    for (const c of clusters) {
      const marker = c.member_id.startsWith(SUSAN_MEMBER_ID) ? " [ALREADY CORRECTED — Susan]" : "";
      console.log(`  ${c.member_id}  ${c.duplicate_count}×${Math.abs(c.points_change).toLocaleString()}pts  ${c.window_seconds}s  ${c.first_created_at} → ${c.last_created_at}${marker}`);
    }
  }

  console.log("");
  console.log("── Already corrected ──────────────────────────────────────");
  console.log(`  Susan D. (member ${SUSAN_MEMBER_ID}, ticket ${SUSAN_TICKET_ID}) —`);
  console.log("  hand-corrected on 2026-07-09; expected in the cluster list above but");
  console.log("  MUST NOT be included in any refund plan.");
  console.log("");
  console.log("── Founder-gated ──────────────────────────────────────────");
  console.log("  This audit surfaces the report ONLY. No refunds are issued and no");
  console.log("  loyalty_transactions / loyalty_members rows are written. Any");
  console.log("  correction is a separate, per-member, human-approved action.");
  console.log("");
}

// Only fire main() when invoked as a script (`npx tsx …`). Guarded so
// the unit test can import `clusterOverDeductions` from this module
// without running the DB query at import time.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1) });
}
