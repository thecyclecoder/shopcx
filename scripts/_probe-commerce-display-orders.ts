/**
 * Probe: verifies `src/lib/commerce/order.ts` and `src/lib/commerce/return.ts`
 * Display ops walk correctly and honor the returns' `refundableOnly` gate
 * (commerce-sdk-display-operations Phase 2 verification).
 *
 * Two checks, matching the spec's Verification block:
 *
 *   1. Stress-walk `listOrdersByCustomer` against the workspace's biggest
 *      customer; expect the returned row count matches
 *      `SELECT COUNT(*) FROM orders WHERE customer_id = $1`.
 *
 *   2. Same probe against `listReturnsByCustomer(refundableOnly:true)`; expect
 *      only rows with `easypost_shipment_id NOT NULL` come back.
 *
 * Usage:
 *   npx tsx scripts/_probe-commerce-display-orders.ts \
 *     [--workspace=<uuid>] [--customer=<uuid>]
 *
 * When --workspace / --customer are omitted, the probe picks the customer with
 * the most orders in the largest workspace so it exercises the >1000-row walk
 * on prod automatically.
 */
import { createAdminClient } from "./_bootstrap";
import { listOrdersByCustomer } from "@/lib/commerce/order";
import { listReturnsByCustomer } from "@/lib/commerce/return";

function parseArgs(argv: string[]): { workspace?: string; customer?: string } {
  const out: { workspace?: string; customer?: string } = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--workspace=")) out.workspace = a.slice("--workspace=".length);
    else if (a.startsWith("--customer=")) out.customer = a.slice("--customer=".length);
  }
  return out;
}

async function pickLargestWorkspace(admin: ReturnType<typeof createAdminClient>): Promise<string | null> {
  const { data, error } = await admin.from("orders").select("workspace_id").limit(50_000);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ workspace_id: string }>) {
    counts.set(r.workspace_id, (counts.get(r.workspace_id) || 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [wsId, n] of counts.entries()) {
    if (n > bestCount) {
      best = wsId;
      bestCount = n;
    }
  }
  return best;
}

async function pickBiggestCustomer(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("orders")
    .select("customer_id")
    .eq("workspace_id", workspaceId)
    .not("customer_id", "is", null)
    .limit(50_000);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ customer_id: string }>) {
    if (!r.customer_id) continue;
    counts.set(r.customer_id, (counts.get(r.customer_id) || 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [cid, n] of counts.entries()) {
    if (n > bestCount) {
      best = cid;
      bestCount = n;
    }
  }
  return best;
}

async function main() {
  const { workspace, customer } = parseArgs(process.argv);
  const admin = createAdminClient();
  let failed = 0;

  const workspaceId = workspace ?? (await pickLargestWorkspace(admin));
  if (!workspaceId) {
    console.error("FAIL: no workspace with orders found");
    process.exit(1);
  }
  const customerId = customer ?? (await pickBiggestCustomer(admin, workspaceId));
  if (!customerId) {
    console.error("FAIL: no customer with orders found in workspace");
    process.exit(1);
  }
  console.log(`workspace=${workspaceId} customer=${customerId}`);

  // ── Check 1: listOrdersByCustomer count matches DB count ───────────
  const { count, error: countErr } = await admin
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId);
  if (countErr) throw countErr;
  const dbCount = count ?? 0;
  const rows = await listOrdersByCustomer(workspaceId, customerId);
  console.log(`listOrdersByCustomer returned ${rows.length} rows; DB count = ${dbCount}`);
  if (rows.length === dbCount) {
    console.log(`PASS: listOrdersByCustomer row count matches SELECT COUNT(*) (${rows.length})`);
  } else {
    console.error(`FAIL: listOrdersByCustomer returned ${rows.length}, expected ${dbCount}`);
    failed++;
  }

  // ── Check 2: listReturnsByCustomer(refundableOnly:true) filter ─────
  const refundable = await listReturnsByCustomer(workspaceId, customerId, { refundableOnly: true });
  console.log(`listReturnsByCustomer(refundableOnly:true) returned ${refundable.length} rows`);
  // Cross-check DB
  const { data: refundableIds, error: refErr } = await admin
    .from("returns")
    .select("id, easypost_shipment_id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .not("easypost_shipment_id", "is", null);
  if (refErr) throw refErr;
  const expectedIds = new Set((refundableIds ?? []).map((r) => r.id as string));
  const returnedIds = new Set(refundable.map((r) => r.id));
  let ok = true;
  if (returnedIds.size !== expectedIds.size) ok = false;
  for (const id of returnedIds) if (!expectedIds.has(id)) ok = false;
  if (ok) {
    console.log(
      `PASS: refundableOnly filter — all ${returnedIds.size} returned rows had easypost_shipment_id NOT NULL`,
    );
  } else {
    console.error(
      `FAIL: refundableOnly filter drifted — returned ${returnedIds.size} rows, expected ${expectedIds.size}`,
    );
    failed++;
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll enabled checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
