/**
 * One-time backfill: convert legacy `fraud_cases.order_ids` entries from
 * Shopify numeric ids to the internal `orders.id` UUID.
 *
 * Phase 2 of docs/brain/specs/fraud-detector-order-ids-store-uuids-not-shopify-ids.md.
 * Phase 1 fixed every writer to store `order.id` and defensively wraps both
 * `.in('id', order_ids)` readers with `orderUuids()`. This script cleans up
 * the ~132 legacy Shopify-numeric-id entries that predate that fix so the
 * fraud graph is complete — otherwise those orders remain silently unmatchable
 * (the reader guard skips them, but the case still points at a broken id).
 *
 * For each `fraud_cases.order_ids` entry that is NOT a valid UUID, look up
 * `orders` where `shopify_order_id = <entry>` (workspace-scoped) and replace
 * with `orders.id`. Any entry that resolves to no order is dropped and logged
 * as an orphan. Rewrites each `order_ids` array in place; UUID entries are
 * left untouched. Prints before/after counts of non-UUID entries.
 *
 * Idempotent: a re-run over an already-UUID-only column is a no-op.
 *
 * Dry-run by default (safe to run any time). Pass `--apply` to mutate.
 *
 * Underscore-prefixed per the throwaway-script convention (`.gitignore`
 * ignores `scripts/_*` for state artifacts, but the source file IS committed
 * so the box worker's commit picks it up — this pattern matches the other
 * `scripts/_*.ts` sweeps).
 *
 * Run: npx tsx scripts/_backfill-fraud-order-ids-to-uuid.ts [--apply]
 */
import { createAdminClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 500;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}\n`);

  // 1. Page through every fraud_cases row for the workspace that carries any
  //    order_ids entry. (An empty `order_ids` is `{}` — nothing to fix; skip
  //    upstream by requiring at least one entry.)
  const cases: Array<{ id: string; order_ids: string[] }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("fraud_cases")
      .select("id, order_ids")
      .eq("workspace_id", WS)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fraud_cases read failed: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) {
      const arr = Array.isArray(r.order_ids) ? (r.order_ids as unknown[]) : [];
      if (arr.length) cases.push({ id: String(r.id), order_ids: arr.map(String) });
    }
    if (data.length < PAGE) break;
  }

  // 2. Baseline: count non-UUID entries across every case's array.
  const nonUuidEntries = new Set<string>();
  for (const c of cases) for (const v of c.order_ids) if (!isUuid(v)) nonUuidEntries.add(v);
  console.log(`Cases scanned: ${cases.length}`);
  console.log(`Distinct non-UUID order_ids entries (Shopify numeric ids): ${nonUuidEntries.size}\n`);

  if (!nonUuidEntries.size) {
    console.log("Nothing to backfill — every fraud_cases.order_ids entry is already a UUID. ✓");
    return;
  }

  // 3. Resolve each Shopify id → orders.id (workspace-scoped) in batches.
  const shopIds = [...nonUuidEntries];
  const shopToUuid = new Map<string, string>();
  for (let i = 0; i < shopIds.length; i += PAGE) {
    const batch = shopIds.slice(i, i + PAGE);
    const { data, error } = await admin
      .from("orders")
      .select("id, shopify_order_id")
      .eq("workspace_id", WS)
      .in("shopify_order_id", batch);
    if (error) throw new Error(`orders lookup failed: ${error.message}`);
    for (const o of data || []) {
      if (o.shopify_order_id) shopToUuid.set(String(o.shopify_order_id), String(o.id));
    }
  }

  const orphans = shopIds.filter((s) => !shopToUuid.has(s));
  console.log(`Resolved to orders.id: ${shopToUuid.size}`);
  console.log(`Orphan Shopify ids (no matching order row — will be dropped): ${orphans.length}`);
  for (const s of orphans) console.log(`    orphan shopify_order_id=${s}`);
  console.log("");

  // 4. Rewrite each case's order_ids array: replace resolved Shopify ids with
  //    their UUID, drop orphans, and de-dup preserving order. UUID entries are
  //    left in place. If nothing changes for a case, skip it.
  type Fix = { id: string; before: string[]; after: string[]; droppedOrphans: string[] };
  const fixes: Fix[] = [];
  for (const c of cases) {
    const seen = new Set<string>();
    const after: string[] = [];
    const droppedOrphans: string[] = [];
    let changed = false;
    for (const v of c.order_ids) {
      if (isUuid(v)) {
        if (!seen.has(v)) { seen.add(v); after.push(v); }
        continue;
      }
      // Non-UUID: try to resolve to a UUID; if none, drop it as an orphan.
      const uuid = shopToUuid.get(v);
      if (uuid) {
        changed = true;
        if (!seen.has(uuid)) { seen.add(uuid); after.push(uuid); }
      } else {
        changed = true;
        droppedOrphans.push(v);
      }
    }
    if (changed) fixes.push({ id: c.id, before: c.order_ids, after, droppedOrphans });
  }

  console.log(`Cases with a rewrite: ${fixes.length}\n`);
  for (const f of fixes) {
    const dropped = f.droppedOrphans.length ? ` · dropped orphans=[${f.droppedOrphans.join(",")}]` : "";
    console.log(`  case ${f.id}: ${f.before.length} → ${f.after.length}${dropped}`);
  }

  if (!apply) {
    console.log(`\nDry-run only. Re-run with --apply to rewrite ${fixes.length} fraud_cases row(s).`);
    return;
  }

  // 5. Apply — one UPDATE per case, workspace-scoped and id-scoped so a
  //    concurrent write to a different workspace's row can never be touched.
  let written = 0;
  for (const f of fixes) {
    const { error } = await admin
      .from("fraud_cases")
      .update({ order_ids: f.after })
      .eq("id", f.id)
      .eq("workspace_id", WS);
    if (error) {
      console.log(`  ✗ case ${f.id}: write failed — ${error.message}`);
      continue;
    }
    written++;
  }
  console.log(`\nWrote ${written}/${fixes.length} case(s).`);

  // 6. Re-scan to confirm: 0 non-UUID entries should remain (minus logged orphans, which were dropped).
  const afterCases: Array<{ id: string; order_ids: string[] }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("fraud_cases")
      .select("id, order_ids")
      .eq("workspace_id", WS)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fraud_cases re-scan failed: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) {
      const arr = Array.isArray(r.order_ids) ? (r.order_ids as unknown[]) : [];
      if (arr.length) afterCases.push({ id: String(r.id), order_ids: arr.map(String) });
    }
    if (data.length < PAGE) break;
  }
  const stillNonUuid = new Set<string>();
  for (const c of afterCases) for (const v of c.order_ids) if (!isUuid(v)) stillNonUuid.add(v);
  console.log(`\nPost-apply distinct non-UUID entries: ${stillNonUuid.size} (target: 0)`);
  if (stillNonUuid.size) for (const v of stillNonUuid) console.log(`    still non-UUID: ${v}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
