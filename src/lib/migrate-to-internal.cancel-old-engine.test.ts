/**
 * cancelOldEngineForMigration — the migration's cancel of the OLD engine contract.
 *
 * Ground truth: the old customer-style cancel stamped `cancelled_at` on our row seconds before
 * the flip (33 live migrated subs carried it), and the Appstle cancel webhook could land before
 * the flip set `migrated_from_contract_id` (the webhook guard's only key). So: vendor-only
 * cancel, Appstle contracts pre-marked before cancelling, the mark restored if the cancel fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cancelOldEngineForMigration } from "./migrate-to-internal";

type Write = { patch: Record<string, unknown>; filters: Array<[string, unknown]> };

/** Records every `subscriptions` update; `.eq()` chains and the chain is awaitable. */
function recordingAdmin(updateError: { message: string } | null = null) {
  const writes: Write[] = [];
  const admin = {
    from: (table: string) => {
      assert.equal(table, "subscriptions");
      return {
        update: (patch: Record<string, unknown>) => {
          const w: Write = { patch, filters: [] };
          writes.push(w);
          const chain = {
            eq: (col: string, val: unknown) => {
              w.filters.push([col, val]);
              return chain;
            },
            then: (resolve: (v: { error: { message: string } | null }) => unknown) => resolve({ error: updateError }),
          };
          return chain;
        },
      };
    },
  };
  return { admin: admin as never, writes };
}

const base = { workspaceId: "ws", subId: "sub-1", contractId: "33357988013", priorMigratedFrom: null };

test("appstle: pre-marks migrated_from_contract_id BEFORE the vendor cancel, writes nothing else", async () => {
  const { admin, writes } = recordingAdmin();
  const seen: string[] = [];
  const r = await cancelOldEngineForMigration(admin, { ...base, engine: "appstle" }, async (_ws, cid, engine) => {
    seen.push(`${cid}:${engine}:writes-before=${writes.length}`);
    return { success: true };
  });
  assert.equal(r.success, true);
  assert.deepEqual(seen, ["33357988013:appstle:writes-before=1"]);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].patch, { migrated_from_contract_id: "33357988013" });
  // Scoped to THIS row, still on its pre-flip contract id.
  assert.deepEqual(writes[0].filters, [["id", "sub-1"], ["shopify_contract_id", "33357988013"]]);
  // Never cancel-truth on our row.
  assert.ok(!writes.some((w) => "status" in w.patch || "cancelled_at" in w.patch));
});

test("appstle: vendor cancel fails → the pre-mark is restored to its prior value", async () => {
  const { admin, writes } = recordingAdmin();
  const r = await cancelOldEngineForMigration(admin, { ...base, engine: "appstle" }, async () => ({ success: false, error: "HTTP 500" }));
  assert.equal(r.success, false);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].patch, { migrated_from_contract_id: null });
  assert.deepEqual(writes[1].filters, [["id", "sub-1"], ["shopify_contract_id", "33357988013"]]);
});

test("appstle: pre-mark write fails → vendor cancel is NOT attempted", async () => {
  const { admin } = recordingAdmin({ message: "db down" });
  let cancelled = false;
  const r = await cancelOldEngineForMigration(admin, { ...base, engine: "appstle" }, async () => {
    cancelled = true;
    return { success: true };
  });
  assert.equal(r.success, false);
  assert.equal(cancelled, false);
  assert.match(r.error || "", /pre-cancel mark failed/);
});

test("shopcx: no pre-mark (row may already hold its origin Appstle id), vendor cancel only", async () => {
  const { admin, writes } = recordingAdmin();
  let engineSeen = "";
  const r = await cancelOldEngineForMigration(
    admin,
    { ...base, contractId: "8123456789", engine: "shopcx", priorMigratedFrom: "27803779245" },
    async (_ws, _cid, engine) => {
      engineSeen = engine;
      return { success: true };
    },
  );
  assert.equal(r.success, true);
  assert.equal(engineSeen, "shopcx");
  assert.equal(writes.length, 0);
});
