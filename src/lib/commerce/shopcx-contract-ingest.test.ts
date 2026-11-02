/**
 * ShopCX contract ingest + sync: the two claim/date rules that keep a contract from being billed
 * on the wrong row or the wrong date.
 *
 *  - F9: the `subscription_contracts/update` sync must never rewind OUR `next_billing_date` to
 *    Shopify's display date. A renewed sub whose retime failed was rewound to the charged cycle,
 *    the cron found that cycle `succeeded` and skipped it every day after.
 *  - F13: a revive records its new contract on the Appstle row before it flips. Ingest must treat
 *    that marker as a claim, or it mints a second subscription for the revived contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existingClaim, syncedNextBillingDate } from "./shopcx-contract-ingest";

// ── F9: syncedNextBillingDate ──────────────────────────────────────────────────

test("F9: a renewed sub keeps OUR advanced date when Shopify still shows the charged one", () => {
  const next = syncedNextBillingDate({
    status: "active",
    ours: "2026-12-10T15:00:00Z",
    shopify: "2026-11-10T15:00:00Z",
    dunningOpen: false,
  });
  assert.equal(next, undefined, "the sync must leave our planner date alone");
});

test("F9: a row with no date is filled from Shopify", () => {
  const next = syncedNextBillingDate({ status: "active", ours: null, shopify: "2026-11-10T15:00:00Z", dunningOpen: false });
  assert.equal(next, "2026-11-10T15:00:00Z");
});

test("F9: an open dunning cycle holds the date even when ours is empty", () => {
  assert.equal(syncedNextBillingDate({ status: "active", ours: null, shopify: "2026-11-10", dunningOpen: true }), undefined);
});

test("F9: a cancelled contract always clears the date", () => {
  assert.equal(syncedNextBillingDate({ status: "cancelled", ours: "2026-12-10", shopify: "2026-12-10", dunningOpen: true }), null);
});

test("F9: a paused contract does not overwrite our date either", () => {
  assert.equal(syncedNextBillingDate({ status: "paused", ours: "2026-12-10", shopify: "2026-11-10", dunningOpen: false }), undefined);
});

// ── F13: existingClaim ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** Minimal PostgREST chain over in-memory tables: select / eq / in / limit / maybeSingle. */
function fakeAdmin(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const chain = {
        select: () => chain,
        eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return chain; },
        in: (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[col])); return chain; },
        limit: () => chain,
        maybeSingle: async () => {
          const hit = (tables[table] ?? []).find((r) => filters.every((f) => f(r)));
          return { data: hit ?? null, error: null };
        },
      };
      return chain;
    },
  } as never;
}

const WS = "ws-1";

test("F13: a contract recorded by a crashed revive is claimed, not re-ingested", async () => {
  const admin = fakeAdmin({
    subscriptions: [
      { id: "sub-appstle", workspace_id: WS, shopify_contract_id: "appstle-555", shopcx_revive_contract_id: "36100000001" },
    ],
  });
  const claim = await existingClaim(WS, "36100000001", admin);
  assert.equal(claim, "created by a ShopCX revive");
});

test("F13: the revive marker is scoped to the workspace", async () => {
  const admin = fakeAdmin({
    subscriptions: [
      { id: "sub-other", workspace_id: "ws-2", shopify_contract_id: "appstle-555", shopcx_revive_contract_id: "36100000001" },
    ],
  });
  assert.equal(await existingClaim(WS, "36100000001", admin), null);
});

test("F13: an unclaimed PDP contract is still ingested", async () => {
  const admin = fakeAdmin({ subscriptions: [], appstle_contract_snapshots: [], one_time_charges: [] });
  assert.equal(await existingClaim(WS, "36100000002", admin), null);
});

test("F13: an already-flipped row still reads as already ingested", async () => {
  const admin = fakeAdmin({
    subscriptions: [{ id: "sub-1", workspace_id: WS, shopify_contract_id: "36100000001", shopcx_revive_contract_id: "36100000001" }],
  });
  assert.equal(await existingClaim(WS, "36100000001", admin), "already ingested");
});
