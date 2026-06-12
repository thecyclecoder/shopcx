/**
 * Workspace-scoped order number generator.
 *
 * Native shopcx orders carry a "SHOPCX<N>" name (e.g. SHOPCX1, SHOPCX2)
 * to distinguish them from Shopify-imported orders (which use the
 * Shopify-assigned `SC<N>` shape).
 *
 * Number scope: per workspace. SHOPCX1 in workspace A is unrelated to
 * SHOPCX1 in workspace B. Sequence is derived by max-and-increment
 * over existing SHOPCX-prefixed orders.
 *
 * Concurrency note: two checkouts firing simultaneously in the same
 * workspace can collide. There's no unique constraint on order_number
 * yet — collisions just result in two orders with the same name. In
 * practice the window is tiny (single-digit milliseconds between read
 * and write) and the impact is cosmetic; a future hardening pass can
 * add a Postgres sequence or a (workspace_id, order_number) unique
 * index if it becomes a real problem.
 */

import { createAdminClient } from "@/lib/supabase/admin";

const PREFIX = "SHOPCX";

export async function generateOrderNumber(workspaceId: string): Promise<string> {
  const admin = createAdminClient();

  // Atomic per-workspace claim. The old max-and-increment below was racy: two
  // concurrent renewals both read the same max and returned the same number,
  // so an order ended up duplicated (Sharon Mogliotti, 2026-06-12: dup SHOPCX6
  // stranded one order from Amplifier). claim_order_number increments under a
  // row lock — see migration 20260612150000_atomic_order_number.
  const { data: claimed, error } = await admin.rpc("claim_order_number", { p_workspace_id: workspaceId });
  if (!error && claimed != null) return `${PREFIX}${claimed}`;
  console.warn("[order-number] claim_order_number RPC unavailable, falling back to (racy) max+1:", error?.message);

  // Legacy fallback (pre-migration / RPC error). We scan the most recent 50
  // rather than ORDER BY order_number because lexical sort treats SHOPCX10 <
  // SHOPCX2. Pull a handful by recency, parse, and take the max.
  const { data } = await admin
    .from("orders")
    .select("order_number")
    .eq("workspace_id", workspaceId)
    .ilike("order_number", `${PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(50);
  let maxN = 0;
  for (const row of data || []) {
    const m = /^SHOPCX(\d+)$/i.exec((row.order_number as string) || "");
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return `${PREFIX}${maxN + 1}`;
}
