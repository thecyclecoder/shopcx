import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "fraud-detector-order-ids-store-uuids-not-shopify-ids",
    {
      title: "Fraud detector: fraud_cases.order_ids must hold internal order UUIDs, not Shopify numeric ids (fixes the invalid-uuid crash + silently-skipped fraud orders)",
      why: "The fraud detector stores fraud_cases.order_ids inconsistently: most write paths put the Shopify numeric order id into order_ids while one writes the internal order UUID. Live data confirms the split — of the order_ids scanned, 132 are Shopify numeric ids and only 26 are UUIDs. Two readers then query orders by internal UUID (orders.id = ANY(order_ids)), so every Shopify-id entry throws Postgres 22P02 (invalid input syntax for type uuid, e.g. \"6956549439661\") and, worse, the whole batch of fraud orders it belongs to is dropped — fraud cross-matching silently misses those orders. This violates the project invariant that internal joins use UUIDs, never shopify_*_id (Shopify is being sunset).",
      what: "Make every fraud_cases.order_ids write store the internal order UUID (order.id); defensively filter order_ids to valid UUIDs at the two readers so a stray legacy id can never crash a fraud match; and backfill the existing Shopify-id entries to their order UUIDs.",
      summary: "In src/lib/fraud-detector.ts change the order_ids writers (~lines 257, 263, 433, 450, 1297, 1383, 1571) to store order.id (the UUID) instead of o.shopify_order_id, matching the one correct writer (~line 703); guard the two orders `.in('id', ...)` readers (~lines 751, 365) with a valid-UUID filter; and backfill the ~132 legacy Shopify-id entries in fraud_cases.order_ids to order UUIDs. Convention: internal joins use UUIDs (operational-rules § Database join discipline).",
      owner: "platform",
      parent: '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: the fraud detector silently drops orders and throws DB errors because order_ids mixes Shopify ids with UUIDs; correctness of this security-sensitive matcher is a reliability concern. See [[../operational-rules]] § Database join discipline and [[../libraries/fraud-detector]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Writers store the order UUID; readers filter to valid UUIDs",
          why: "Most writers store shopify_order_id into order_ids, and the UUID readers crash (and drop the batch) on those entries.",
          what: "Standardize all order_ids writes to order.id, and defensively UUID-filter the two readers so a stray legacy id can't crash or silently drop a match.",
          body: "In src/lib/fraud-detector.ts: (1) change every fraud_cases.order_ids write that currently maps o.shopify_order_id — the assignments at ~lines 257, 263, 433, 450 and the single-element writes at ~1297, 1383, 1571 (order_ids: [order.shopify_order_id]) — to use the internal UUID (o.id / order.id), matching the already-correct writer at ~line 703 (order_ids: [order.id]). The mapped objects are order rows that carry .id; select it where a scope lacks it. (2) Add a small exported helper `orderUuids(ids: unknown[]): string[]` that keeps only values matching the UUID shape, and wrap BOTH readers that do `.in('id', <order_ids>)` (~line 751 batch loop and ~line 365 velocity path) so a non-UUID can never reach the query. Do NOT switch the readers to shopify_order_id — UUID is the invariant; Shopify is being sunset. Leave the genuinely-Shopify uses that are NOT order_ids (e.g. the shopIds lookup ~line 1116) unchanged. Update docs/brain/libraries/fraud-detector.md and docs/brain/tables/fraud_cases.md (order_ids holds UUIDs) per CLAUDE.md.",
          verification: "- tsc clean\n- the orderUuids guard exists and both readers use it\n- no order_ids write maps o.shopify_order_id",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the valid-UUID guard helper exists", kind: "auto", exec_kind: "grep", params: { pattern: "orderUuids", path: "src/lib/fraud-detector.ts", expect: "present" } },
            { position: 3, description: "no order_ids write stores a Shopify id", kind: "auto", exec_kind: "grep", params: { pattern: "order_ids: [order.shopify_order_id]", path: "src/lib/fraud-detector.ts", expect: "absent" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — Backfill existing order_ids from Shopify ids to order UUIDs",
          why: "~132 legacy order_ids entries are Shopify numeric ids; without a backfill those fraud orders stay unmatchable even after the writers are fixed.",
          what: "Convert the existing Shopify-id entries in fraud_cases.order_ids to their internal order UUIDs.",
          body: "Add scripts/_backfill-fraud-order-ids-to-uuid.ts (a `_` throwaway) that, via createAdminClient(), scans fraud_cases.order_ids for this workspace, and for each entry that is NOT a UUID looks up public.orders where shopify_order_id = that value (workspace-scoped) and replaces it with orders.id; drop any entry that resolves to no order (an orphan) and log it. Rewrite each fraud_cases.order_ids array in place. Print before/after counts of non-UUID entries (target: 0 remaining, minus logged orphans). Confirm no fraud_cases.order_ids entry is non-UUID afterward. Note the one-time backfill in docs/brain/tables/fraud_cases.md per CLAUDE.md.",
          verification: "- tsc clean\n- the backfill script exists and resolves shopify_order_id → orders.id",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "backfill script present", kind: "auto", exec_kind: "grep", params: { pattern: "fraud_cases", path: "scripts/_backfill-fraud-order-ids-to-uuid.ts", expect: "present" } },
            { position: 3, description: "backfill resolves via shopify_order_id", kind: "auto", exec_kind: "grep", params: { pattern: "shopify_order_id", path: "scripts/_backfill-fraud-order-ids-to-uuid.ts", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#infra-devops-reliability" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
