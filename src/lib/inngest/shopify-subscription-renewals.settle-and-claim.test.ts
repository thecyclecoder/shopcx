/**
 * ShopCX renewal: the claim key and the settlement of pending attempts.
 *
 *  - F5: a pending attempt (3DS, or a >30s poll) left the cycle claim `in_flight` forever. Every
 *    later cron run was refused, Order Now was blocked, a slow success was never advanced and a
 *    later failure never reached dunning. The cron now settles those claims from Shopify's own
 *    record of the attempt.
 *  - F8: the worker keyed its claim off the LIVE `next_billing_date`, which a successful charge
 *    moves. An order-now loading the sub seconds after the cron charged claimed the next cycle and
 *    charged again. The key now comes from the dispatched date; the portal claims too.
 *  - F4: a contract a failed normalization left at MSRP is normalized before its renewal charges.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  settlePendingShopcxClaims,
  pendingSettleVerdict,
  shopcxAttemptKeyForClaim,
  SHOPCX_PORTAL_CLAIM_SOURCE,
  SHOPCX_RENEWAL_CLAIM_SOURCE,
  type SettleDeps,
} from "./shopify-subscription-renewals";
import { shouldRepairUnnormalizedContract, type RenewalPriceVerdict } from "../commerce/shopcx-renewal-price-check";
import { isWedgedCycleCharge } from "../control-tower/monitor";
import { STALE_IN_FLIGHT_RECLAIM_MS } from "../subscription-cycle-charge-claim";

const SRC = readFileSync(join(__dirname, "shopify-subscription-renewals.ts"), "utf8");

// ── F5: settling pending claims ────────────────────────────────────────────────

const SUB = {
  id: "sub-1", workspace_id: "ws-1", shopify_contract_id: "36100000001", status: "active",
  next_billing_date: "2026-11-10T15:00:00Z", billing_source: "shopcx", customer_id: "c-1",
  shopify_customer_id: "sc-1", billing_interval: "week", billing_interval_count: 4,
};

function harness(opts: {
  claims?: Array<{ id: string; subscription_id: string; cycle_key: string; source: string | null }>;
  sub?: typeof SUB | null;
  attempt?: { success: boolean; found?: boolean; attempt?: { success: boolean; terminal: boolean; orderId?: string } };
  advanceResult?: Date | null;
}) {
  const calls = { resolved: [] as Array<{ id: string; status: string; order_id?: string | null }>, advanced: [] as string[], keys: [] as string[], order: [] as string[] };
  const deps: SettleDeps = {
    listClaims: async () => opts.claims ?? [{ id: "claim-1", subscription_id: "sub-1", cycle_key: "2026-11-10", source: SHOPCX_RENEWAL_CLAIM_SOURCE }],
    loadSub: async () => (opts.sub === undefined ? SUB : opts.sub),
    findAttempt: async (_ws, _c, key) => { calls.keys.push(key); return opts.attempt ?? { success: true, found: false }; },
    resolveClaim: async (id, input) => { calls.order.push("resolve"); calls.resolved.push({ id, status: input.status, order_id: input.order_id }); return { updated: true }; },
    orderUuid: async (_ws, gid) => (gid ? "order-uuid-1" : undefined),
    advance: async (_sub, scheduledFor) => { calls.order.push("advance"); calls.advanced.push(scheduledFor); return opts.advanceResult === undefined ? new Date("2026-12-08T15:00:00Z") : opts.advanceResult; },
  };
  return { deps, calls };
}

test("F5: a pending attempt that later succeeded is advanced once, then its claim resolved", async () => {
  const { deps, calls } = harness({ attempt: { success: true, found: true, attempt: { success: true, terminal: true, orderId: "gid://shopify/Order/1" } } });
  const counts = await settlePendingShopcxClaims(deps);
  assert.equal(counts.succeeded, 1);
  assert.equal(counts.advanced, 1);
  assert.deepEqual(calls.advanced, ["2026-11-10T15:00:00Z"]);
  assert.deepEqual(calls.resolved, [{ id: "claim-1", status: "succeeded", order_id: "order-uuid-1" }]);
  assert.deepEqual(calls.order, ["advance", "resolve"], "advance BEFORE resolve, so a crash never strands a succeeded claim on an old date");
});

test("F5: a succeeded claim on a sub whose date already moved is resolved but never advanced again", async () => {
  const { deps, calls } = harness({
    sub: { ...SUB, next_billing_date: "2026-12-08T15:00:00Z" },
    attempt: { success: true, found: true, attempt: { success: true, terminal: true } },
  });
  await settlePendingShopcxClaims(deps);
  assert.deepEqual(calls.advanced, []);
  assert.equal(calls.resolved[0].status, "succeeded");
});

test("F5: a pending attempt that later failed releases the claim (no new charge here, no dunning dispatch here)", async () => {
  const { deps, calls } = harness({ attempt: { success: true, found: true, attempt: { success: false, terminal: true } } });
  const counts = await settlePendingShopcxClaims(deps);
  assert.equal(counts.failed, 1);
  assert.deepEqual(calls.resolved, [{ id: "claim-1", status: "failed", order_id: undefined }]);
  assert.deepEqual(calls.advanced, []);
});

test("F5: still pending, not found, or unreadable leaves the claim in_flight", async () => {
  for (const attempt of [
    { success: true, found: true, attempt: { success: false, terminal: false } },
    { success: true, found: false },
    { success: false },
  ]) {
    const { deps, calls } = harness({ attempt });
    await settlePendingShopcxClaims(deps);
    assert.deepEqual(calls.resolved, [], `must not release on ${JSON.stringify(attempt)}`);
    assert.deepEqual(calls.advanced, []);
  }
});

test("F5: a sub that left the shopcx engine is skipped untouched", async () => {
  const { deps, calls } = harness({ sub: { ...SUB, billing_source: "internal" } });
  const counts = await settlePendingShopcxClaims(deps);
  assert.equal(counts.skipped, 1);
  assert.deepEqual(calls.keys, []);
});

test("F5: the attempt is looked up by the exact key each path sent", async () => {
  assert.equal(shopcxAttemptKeyForClaim("36100000001", { cycle_key: "2026-11-10", source: SHOPCX_RENEWAL_CLAIM_SOURCE }), "36100000001:2026-11-10");
  assert.equal(shopcxAttemptKeyForClaim("36100000001", { cycle_key: "2026-11-10", source: SHOPCX_PORTAL_CLAIM_SOURCE }), "36100000001:2026-11-10:portal");
  // …and those are the keys the two charge sites build.
  assert.match(SRC, /`\$\{sub\.shopify_contract_id\}:\$\{cycleKey\}`,/);
  const PORTAL = readFileSync(join(__dirname, "..", "portal", "handlers", "order-now.ts"), "utf8");
  assert.match(PORTAL, /`\$\{contractId\}:\$\{cycleKey\}:portal`/);
});

test("F5: pendingSettleVerdict never reads an unseen attempt as failed", () => {
  assert.equal(pendingSettleVerdict({ found: false }), "not_found");
  assert.equal(pendingSettleVerdict({ found: true, attempt: { success: false, terminal: false } }), "pending");
  assert.equal(pendingSettleVerdict({ found: true, attempt: { success: false, terminal: true } }), "failed");
  assert.equal(pendingSettleVerdict({ found: true, attempt: { success: true, terminal: true } }), "succeeded");
});

test("F5: the cron settles BEFORE it selects due subs", () => {
  const settle = SRC.indexOf('step.run("settle-pending-attempts"');
  const select = SRC.indexOf('step.run("find-due-subs"');
  const gate = SRC.indexOf('enforceSwitch("shopify-subscription-renewal-cron")');
  assert.ok(gate > 0 && settle > gate && select > settle, "kill switch → settle → select");
});

test("F5: the wedged-cycle monitor now sees a stranded ShopCX in_flight claim", () => {
  const now = Date.now();
  const stale = new Date(now - STALE_IN_FLIGHT_RECLAIM_MS - 60_000).toISOString();
  const sub = { next_billing_date: "2026-11-10T15:00:00Z", billing_source: "shopcx" };
  assert.equal(isWedgedCycleCharge({ cycle_key: "2026-11-10", status: "in_flight", claimed_at: stale }, sub, now), true);
  // A failed claim on a ShopCX sub is the normal dunning hold, not a wedge.
  assert.equal(isWedgedCycleCharge({ cycle_key: "2026-11-10", status: "failed", claimed_at: stale }, sub, now), false);
  const MON = readFileSync(join(__dirname, "..", "control-tower", "monitor.ts"), "utf8");
  const fn = MON.slice(MON.indexOf("export async function countRenewalWedgedCycles"));
  assert.match(fn.slice(0, 2500), /\.or\("is_internal\.eq\.true,billing_source\.eq\.shopcx"\)/);
});

// ── F8: claim key from the dispatched date ─────────────────────────────────────

test("F8: the worker keys its claim off the dispatched date, never the live row", () => {
  assert.match(SRC, /const cycleKey = cycleKeyFromDispatchedNextBillingDate\(expected_next_billing_date\);/);
  assert.doesNotMatch(SRC, /const cycleKey = cycleKeyFromNextBillingDate\(sub\.next_billing_date\)/);
  // An event without a dispatched date is refused before any claim or charge.
  const refuse = SRC.indexOf('reason: "missing_dispatched_cycle"');
  assert.ok(refuse > 0 && refuse < SRC.indexOf('step.run("claim-cycle"'));
});

test("F8: subscriptionOrderNow stamps the pre-charge date on ShopCX events", () => {
  const SDK = readFileSync(join(__dirname, "..", "commerce", "subscription.ts"), "utf8");
  const branch = SDK.slice(SDK.indexOf('if (src === "shopcx") {\n      const { RENEWAL_ATTEMPT_EVENT }'));
  const send = branch.slice(0, branch.indexOf("return {"));
  assert.match(send, /expected_next_billing_date: \(sub as \{ next_billing_date\?: string \| null \}\)\.next_billing_date \?\? null/);
  assert.match(send, /order_now: true/);
  assert.doesNotMatch(send, /expected_next_billing_date: null/);
});

test("F8: the portal ShopCX Order Now claims the cycle before charging", () => {
  const PORTAL = readFileSync(join(__dirname, "..", "portal", "handlers", "order-now.ts"), "utf8");
  const branch = PORTAL.slice(PORTAL.indexOf('if (orderNowEngine === "shopcx")'));
  const claim = branch.indexOf("claimCycleCharge(admin, {");
  const charge = branch.indexOf("shopifyAttemptBilling(");
  assert.ok(claim > 0 && charge > claim, "claim BEFORE the charge");
  assert.match(branch.slice(claim, charge), /cycle_key: cycleKey/);
  assert.match(branch.slice(claim, charge), /if \(!claim\.ok\) \{\s*return jsonErr\(\{ error: "order_in_progress"/);
  assert.match(branch, /const cycleKey = cycleKeyFromDispatchedNextBillingDate\(due\);/);
  // Success resolves the claim only after the date has moved.
  const advance = branch.indexOf("next_billing_date: advanceTo.toISOString()");
  const resolved = branch.indexOf('resolveCycleCharge(admin, claim.id, { status: "succeeded" })');
  assert.ok(advance > 0 && resolved > advance);
});

// ── F4: pre-charge repair of an un-normalized contract ─────────────────────────

const mismatch = (status: "overcharge" | "undercharge", contractStructuralCents: number): RenewalPriceVerdict =>
  ({ status, expectedCents: 5246, actualCents: 6995, lines: [], contractStructuralCents });

test("F4: an overcharging contract with no structural allocation is repaired before the charge", () => {
  assert.equal(shouldRepairUnnormalizedContract(mismatch("overcharge", 0)), true);
});

test("F4: a contract already in our shape, an undercharge, or a match is never touched", () => {
  assert.equal(shouldRepairUnnormalizedContract(mismatch("overcharge", 1749)), false);
  assert.equal(shouldRepairUnnormalizedContract(mismatch("undercharge", 0)), false);
  assert.equal(shouldRepairUnnormalizedContract({ status: "match", expectedCents: 1, actualCents: 1 }), false);
  assert.equal(shouldRepairUnnormalizedContract({ status: "unchecked", reason: "x" }), false);
});

test("F4: the repair runs after the claim and before the charge", () => {
  const claim = SRC.indexOf('step.run("claim-cycle"');
  const repair = SRC.indexOf("shopcxNormalizeNewContract(workspace_id, sub.shopify_contract_id)");
  const charge = SRC.indexOf('step.run("attempt-billing"');
  assert.ok(claim > 0 && repair > claim && charge > repair);
});
