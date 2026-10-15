/**
 * close-snapshot-coverage-guard Phase 2 — `assertSameDayCoverage` is the same-day self-heal guard
 * over the three POINT-IN-TIME close tables (3PL inventory, FBA inventory, FBA inbound). Their data
 * reports NOW and cannot be rebuilt later, so a missing day is only recoverable on the day it is
 * missing. The guard counts today's rows, retries the specific sync once inline when a table is
 * empty, and escalates a CEO `close_snapshot_gap` card (at most one per workspace/table/date) when a
 * table is STILL empty — shouting when the day is a month-end, the case qb-close-guard blocks on.
 *
 * Pins the three behaviours the spec names:
 *   - a table with rows            → no retry, no card
 *   - a table empty after retry    → exactly one card (and idempotent on re-run)
 *   - a month-end date             → the month-end wording
 *
 * Run: npx tsx --test src/lib/qb-close/sync-sources.coverage.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSameDayCoverage } from "./sync-sources";

/**
 * Minimal Supabase stub. Snapshot tables resolve to a fixed count (the inline retry writes nothing
 * in the stub, so the count after retry is unchanged — exactly the "still empty" case). The
 * `dashboard_notifications` existence check reads back the cards actually inserted this run, so the
 * one-card-per-(workspace,table,date) dedupe is exercised end-to-end.
 */
function makeAdmin(counts: Record<string, number>) {
  const inserted: Array<Record<string, any>> = [];
  const admin: any = {
    from(table: string) {
      if (table === "dashboard_notifications") {
        const filters: Record<string, any> = {};
        const b: any = {
          select() { return b; },
          eq(col: string, val: any) { filters[col] = val; return b; },
          maybeSingle() {
            const match = inserted.find(
              (row) =>
                row.metadata?.type === filters["metadata->>type"] &&
                row.metadata?.table === filters["metadata->>table"] &&
                row.metadata?.date === filters["metadata->>date"],
            );
            return Promise.resolve({ data: match ? { id: "existing" } : null, error: null });
          },
          insert(row: Record<string, any>) {
            inserted.push(row);
            return Promise.resolve({ error: null });
          },
        };
        return b;
      }
      // A snapshot table: a count/HEAD query. The builder is thenable so `await …eq().eq()` resolves.
      const b: any = {
        select() { return b; },
        eq() { return b; },
        then(resolve: (v: any) => void) { resolve({ count: counts[table] ?? 0, error: null }); },
      };
      return b;
    },
  };
  return { admin: admin as SupabaseClient, inserted };
}

const WS = "00000000-0000-0000-0000-000000000000";
const stub = (table: string) => async () => ({ table, rows: 0 });
const coverageFor = (table: string) => [{ table, sync: stub(table) }];

test("a table WITH rows for today → no retry, no card", async () => {
  const { admin, inserted } = makeAdmin({ qb_tpl_inventory_snapshots: 5 });
  const out = await assertSameDayCoverage(admin, WS, "2026-01-15", coverageFor("qb_tpl_inventory_snapshots"));
  assert.equal(out.length, 1);
  assert.equal(out[0].present, true);
  assert.equal(out[0].retried, false, "a present table must not trigger a retry");
  assert.equal(out[0].cardRaised, false);
  assert.equal(inserted.length, 0, "no card when the snapshot is present");
});

test("a table EMPTY after retry → exactly one card carrying close_snapshot_gap metadata", async () => {
  const { admin, inserted } = makeAdmin({ qb_amazon_inventory_snapshots: 0 });
  const out = await assertSameDayCoverage(admin, WS, "2026-01-15", coverageFor("qb_amazon_inventory_snapshots"));
  assert.equal(out[0].present, false);
  assert.equal(out[0].retried, true, "an empty table must be retried once inline");
  assert.equal(out[0].cardRaised, true);
  assert.equal(inserted.length, 1, "exactly one card for an empty-after-retry table");
  const card = inserted[0];
  assert.equal(card.type, "system");
  assert.equal(card.link, "/dashboard/agents/cfo");
  assert.equal(card.metadata.type, "close_snapshot_gap");
  assert.equal(card.metadata.table, "qb_amazon_inventory_snapshots");
  assert.equal(card.metadata.date, "2026-01-15");
  assert.equal(card.metadata.month_end, false);
});

test("re-running on a still-empty day does NOT raise a second card (one per workspace/table/date)", async () => {
  const { admin, inserted } = makeAdmin({ qb_inbound_shipment_snapshots: 0 });
  await assertSameDayCoverage(admin, WS, "2026-01-15", coverageFor("qb_inbound_shipment_snapshots"));
  const second = await assertSameDayCoverage(admin, WS, "2026-01-15", coverageFor("qb_inbound_shipment_snapshots"));
  assert.equal(inserted.length, 1, "the existence check must suppress the duplicate card");
  assert.equal(second[0].cardRaised, false, "second pass finds the existing card and raises nothing");
});

test("a MONTH-END date → the month-end wording and month_end:true metadata", async () => {
  const { admin, inserted } = makeAdmin({ qb_tpl_inventory_snapshots: 0 });
  const out = await assertSameDayCoverage(admin, WS, "2026-01-31", coverageFor("qb_tpl_inventory_snapshots"));
  assert.equal(out[0].isMonthEnd, true);
  const card = inserted[0];
  assert.match(card.title, /MONTH-END/, "the title must flag the month-end case");
  assert.match(card.body, /LAST DAY OF THE MONTH/, "the body must state it blocks the close");
  assert.equal(card.metadata.month_end, true);
});

test("a non-month-end date is NOT flagged as month-end", async () => {
  const { admin, inserted } = makeAdmin({ qb_tpl_inventory_snapshots: 0 });
  const out = await assertSameDayCoverage(admin, WS, "2026-01-30", coverageFor("qb_tpl_inventory_snapshots"));
  assert.equal(out[0].isMonthEnd, false);
  assert.doesNotMatch(inserted[0].title, /MONTH-END/);
  assert.equal(inserted[0].metadata.month_end, false);
});
