/**
 * Unit tests for commerce/shopcx-revive — the "revive builds on ShopCX from our mirror" rule that
 * lets Appstle be uninstalled.
 *
 * Pins:
 *  - the mirror → plan → contract-input mapping (delivery price KEPT, lapsed date ROLLED FORWARD,
 *    MSRP lines + S&S / grandfather discounts, status by intent, address fallback, card choice);
 *  - ensureShopcxEngine routing with the appstle_retired switch OFF (untouched passthrough) and ON
 *    (cancel/pause local-only, everything else builds and rebinds the contract id);
 *  - idempotency: a second revive reuses the first contract, concurrent revives create ONE, a
 *    recorded-but-unflipped contract is adopted;
 *  - typed refusals: needs_payment_method / needs_address / subscription_cancelled;
 *  - ZERO Appstle calls: a global fetch trap fails the test on any appstle.com request.
 *
 * No Supabase, no Shopify, no Appstle — every I/O seam is an injected fake.
 *
 * Run: npm run test:commerce-shopcx-revive
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildShopcxFromMirror,
  ensureShopcxEngine,
  planShopcxFromMirror,
  resolveReviveAddress,
  resolveReviveNextBillingDate,
  pickUsableCard,
  droppedMirrorCodes,
  targetStatusForIntent,
  type MirrorRow,
  type ReviveDeps,
  type EnsureDeps,
  type ReviveResult,
} from "./shopcx-revive";
import type { PricingContext, CatalogVariant } from "./shopify-subscription-migrate";
import type { PaymentMethod } from "@/lib/dunning";

const WS = "11111111-1111-1111-1111-111111111111";
const SUB = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-10-26T15:00:00Z");

// ── Global trap: the revive must make ZERO Appstle calls (and, with fakes, zero network calls). ──
const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];
test.before(() => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    throw new Error(`unexpected network call in a unit test: ${String(url)}`);
  }) as typeof fetch;
});
test.after(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(fetchCalls.filter((u) => /appstle/i.test(u)), [], "no Appstle call may be made");
});

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

function variant(id: string, product_id: string, sku: string, shopify_variant_id: string, price_cents: number): CatalogVariant {
  return { id, product_id, sku, shopify_variant_id, price_cents };
}

function pricingCtx(): PricingContext {
  const coffee = variant("v-uuid-1", "p-coffee", "COF-1", "111", 7995);
  const tea = variant("v-uuid-2", "p-tea", "TEA-1", "222", 4995);
  const prot = variant("v-uuid-3", "p-prot", "PROT", "333", 0);
  const all = [coffee, tea, prot];
  return {
    snsPct: 25,
    breaks: [{ quantity: 2, discount_pct: 8 }, { quantity: 3, discount_pct: 12 }],
    ruleProducts: new Set(["p-coffee", "p-tea"]),
    productTitle: new Map([["p-coffee", "Coffee"], ["p-tea", "Tea"], ["p-prot", "Shipping Protection"]]),
    variantBySku: new Map(all.map((v) => [String(v.sku).toLowerCase(), v])),
    variantByShopifyId: new Map(all.map((v) => [String(v.shopify_variant_id), v])),
  };
}

const ADDRESS = {
  firstName: "Ada", lastName: "Lovelace", address1: "1 Main St", address2: "", city: "Austin",
  province: "Texas", provinceCode: "TX", zip: "78701", country: "United States", countryCode: "US", phone: "",
};

function mirrorRow(over: Partial<MirrorRow> = {}): MirrorRow {
  return {
    id: SUB,
    workspace_id: WS,
    customer_id: "cust-1",
    shopify_contract_id: "27000000001",
    shopify_customer_id: "7000001",
    status: "paused",
    billing_source: "appstle",
    billing_interval: "week",
    billing_interval_count: 4,
    // LAPSED: weeks before NOW.
    next_billing_date: "2026-09-01T12:00:00Z",
    items: [{ sku: "COF-1", variant_id: "111", quantity: 1, price_cents: 5996, title: "Coffee" }],
    delivery_price_cents: 599,
    shipping_method_code: "economy",
    applied_discounts: [],
    shipping_address: ADDRESS,
    pause_resume_at: "2026-11-15T00:00:00Z",
    shopcx_revive_claimed_at: null,
    shopcx_revive_contract_id: null,
    ...over,
  };
}

const CARD: PaymentMethod = { id: "gid://shopify/CustomerPaymentMethod/abc", last4: "4242", expiryMonth: 12, expiryYear: 2030, brand: "visa", name: "Ada", dedupeKey: "4242-12-2030" };
const EXPIRED: PaymentMethod = { ...CARD, id: "gid://shopify/CustomerPaymentMethod/old", expiryMonth: 1, expiryYear: 2025, dedupeKey: "x" };

/** An in-memory `subscriptions` row + Shopify, with counters. */
function fakeDeps(row: MirrorRow, over: Partial<ReviveDeps> & { methods?: PaymentMethod[]; customer?: { shopify_customer_id: string | null; default_address: unknown } | null } = {}) {
  const state = { row: { ...row } as MirrorRow, creates: 0, flips: [] as Record<string, unknown>[], claims: 0, lastInput: null as unknown };
  const deps: ReviveDeps = {
    now: () => NOW,
    loadRow: async () => ({ ...state.row }),
    loadCustomer: async () => (over.customer === undefined ? { shopify_customer_id: "7000001", default_address: null } : over.customer),
    listPaymentMethods: async () => over.methods ?? [CARD],
    loadPricingContext: async () => pricingCtx(),
    claim: async (_id, prev, nowIso) => {
      state.claims++;
      if (state.row.billing_source !== "appstle" || state.row.shopcx_revive_contract_id) return false;
      if ((state.row.shopcx_revive_claimed_at ?? null) !== (prev ?? null)) return false;
      state.row.shopcx_revive_claimed_at = nowIso;
      return true;
    },
    recordContract: async (_id, contractId) => { state.row.shopcx_revive_contract_id = contractId; return {}; },
    findOrphans: async () => [],
    createContract: async (_ws, input) => {
      state.creates++;
      state.lastInput = input;
      return { success: true, contractId: `gid://shopify/SubscriptionContract/9900${state.creates}` };
    },
    syncSchedule: async () => {},
    flip: async (_id, update) => {
      if (state.row.billing_source !== "appstle") return { matched: 0 };
      state.flips.push(update);
      state.row = { ...state.row, ...(update as Partial<MirrorRow>) };
      return { matched: 1 };
    },
    mirrorPricing: async () => {},
    ...over,
  };
  return { deps, state };
}

// ── Pure mapping ────────────────────────────────────────────────────────────────────────────

test("mirror → plan: delivery price KEPT, lapsed date ROLLED FORWARD on the customer's cadence, MSRP + S&S + grandfather", () => {
  const row = mirrorRow();
  const r = planShopcxFromMirror({
    row, intent: "change", ctx: pricingCtx(), card: CARD, customerGid: "gid://shopify/Customer/7000001",
    address: resolveReviveAddress({ row: row.shipping_address as Record<string, unknown> }), now: NOW,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // A change on a PAUSED sub keeps it paused.
  assert.equal(r.status, "PAUSED");
  assert.equal((r.createInput.contract as { status: string }).status, "PAUSED");
  // 09-01 + 4w steps: 09-29, 10-27 → first date after NOW, same weekday.
  assert.equal(r.nextBillingDate, "2026-10-27T12:00:00.000Z");
  assert.equal(r.createInput.nextBillingDate, "2026-10-27T12:00:00.000Z");
  const c = r.createInput.contract as Record<string, any>;
  // ⭐ Dylan's shipping rule: never zeroed.
  assert.equal(c.deliveryPrice, "5.99");
  assert.equal(c.paymentMethodId, CARD.id);
  assert.equal(c.billingPolicy.interval, "WEEK");
  assert.equal(c.billingPolicy.intervalCount, 4);
  assert.equal(c.deliveryPolicy.interval, "WEEK");
  assert.equal(c.deliveryPolicy.anchors, undefined, "no delivery anchors");
  assert.deepEqual(c.deliveryMethod.shipping.address, {
    address1: "1 Main St", city: "Austin", countryCode: "US", firstName: "Ada", lastName: "Lovelace", provinceCode: "TX", zip: "78701",
  });
  assert.deepEqual(c.deliveryMethod.shipping.shippingOption, { title: "Economy", code: "economy" });
  assert.equal(r.createInput.customerId, "gid://shopify/Customer/7000001");
  // MSRP line with S&S 25% and a 1c legacy lock (standard 59.97 vs 59.96 today) — nobody pays more.
  assert.equal(r.createInput.lines.length, 1);
  const line = r.createInput.lines[0] as { line: Record<string, unknown>; discounts: { title: string; value: unknown }[] };
  assert.equal(line.line.productVariantId, "gid://shopify/ProductVariant/111");
  assert.equal(line.line.currentPrice, "79.95");
  assert.deepEqual(line.discounts.map((d) => d.title), ["Subscribe & Save", "Legacy rate"]);
  assert.equal(r.plan.newTotalCents, 5996);
});

test("mirror → plan: a delivery price of 0 stays 0 and a missing one is not invented", () => {
  const row = mirrorRow({ delivery_price_cents: 0 });
  const r = planShopcxFromMirror({
    row, intent: "change", ctx: pricingCtx(), card: CARD, customerGid: "gid://shopify/Customer/1",
    address: resolveReviveAddress({ row: ADDRESS }), now: NOW,
  });
  assert.equal(r.ok && (r.createInput.contract as { deliveryPrice: string }).deliveryPrice, "0.00");
});

test("mirror → plan: a future date is kept verbatim; a cancelled row with no date revives tomorrow", () => {
  assert.equal(resolveReviveNextBillingDate("2026-11-20T09:00:00Z", "month", 1, NOW), "2026-11-20T09:00:00.000Z");
  assert.equal(resolveReviveNextBillingDate(null, "month", 1, NOW), "2026-10-27T15:00:00.000Z");
  // An override (portal-chosen date) wins; a past override still rolls forward.
  assert.equal(resolveReviveNextBillingDate("2026-09-01T00:00:00Z", "month", 1, NOW, "2026-11-02T00:00:00Z"), "2026-11-02T00:00:00.000Z");
  assert.equal(resolveReviveNextBillingDate(null, "month", 1, NOW, "2026-10-01T00:00:00Z"), "2026-11-01T00:00:00.000Z");
});

test("status by intent: revive → ACTIVE; change keeps paused/active; change on cancelled is refused; cancel/pause never build", () => {
  assert.deepEqual(targetStatusForIntent("cancelled", "resume"), { status: "ACTIVE" });
  assert.deepEqual(targetStatusForIntent("paused", "resume"), { status: "ACTIVE" });
  assert.deepEqual(targetStatusForIntent("paused", "change"), { status: "PAUSED" });
  assert.deepEqual(targetStatusForIntent("active", "change"), { status: "ACTIVE" });
  assert.equal((targetStatusForIntent("cancelled", "change") as { refuse: string }).refuse, "subscription_cancelled");
  assert.equal((targetStatusForIntent("active", "cancel") as { refuse: string }).refuse, "local_only_intent");
  assert.equal((targetStatusForIntent("active", "pause") as { refuse: string }).refuse, "local_only_intent");
});

test("address: row first, then the customer's default; incomplete → needs_address with the missing fields", () => {
  const fromDefault = resolveReviveAddress({ row: { address1: "x" }, customerDefault: { address1: "9 Elm", city: "Reno", country_code: "US", zip: "89501", last_name: "Hopper", province_code: "NV" } });
  assert.equal(fromDefault.source, "default_address");
  assert.equal(fromDefault.address?.city, "Reno");
  const override = resolveReviveAddress({ override: { address1: "5 Oak", city: "Waco", country: "US", zip: "76701", lastName: "Turing" }, row: ADDRESS });
  assert.equal(override.source, "override");
  const none = resolveReviveAddress({ row: { address1: "1 Main", city: "Austin" }, customerDefault: null });
  assert.equal(none.address, null);
  // (A blank country normalizes to US via normalizeCountryToIso2, so it is not reported missing.)
  assert.deepEqual(none.missing, ["zip", "lastName"]);
});

test("card: expired skipped, preferred honoured when usable", () => {
  assert.equal(pickUsableCard([EXPIRED], NOW), null);
  assert.equal(pickUsableCard([EXPIRED, CARD], NOW)?.id, CARD.id);
  const other = { ...CARD, id: "gid://shopify/CustomerPaymentMethod/pref" };
  assert.equal(pickUsableCard([CARD, other], NOW, other.id)?.id, other.id);
  assert.equal(pickUsableCard([CARD], NOW, EXPIRED.id)?.id, CARD.id);
});

test("codes: every customer code is dropped and named; structural and Buy-N are recomputed, not listed", () => {
  const r = droppedMirrorCodes([
    { title: "Subscribe & Save", type: "MANUAL", value: 25, valueType: "PERCENTAGE" },
    { title: "Buy 2 Discount_x", type: "CODE_DISCOUNT", value: 8, valueType: "PERCENTAGE" },
    { title: "VIP10", type: "CODE_DISCOUNT", value: 10, valueType: "PERCENTAGE", targetType: "LINE_ITEM" },
    { title: "LOYALTY-5", type: "CODE_DISCOUNT", value: 5, valueType: "FIXED_AMOUNT" },
    { title: "Free Shipping on Subscriptions", type: "CODE_DISCOUNT", value: 100, valueType: "PERCENTAGE", targetType: "SHIPPING_LINE" },
  ]);
  assert.deepEqual(r, ["VIP10", "LOYALTY-5", "Free Shipping on Subscriptions"]);
  assert.deepEqual(droppedMirrorCodes(null), []);
});

// ── buildShopcxFromMirror ───────────────────────────────────────────────────────────────────

test("build: creates once, records the contract before the flip, flips the row to shopcx", async () => {
  const { deps, state } = fakeDeps(mirrorRow());
  const r = await buildShopcxFromMirror(WS, SUB, "resume", {}, deps);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.contractId, "99001");
  assert.equal(r.reused, false);
  assert.equal(r.flipped, true);
  assert.equal(r.status, "active");
  assert.equal(state.creates, 1);
  assert.equal(state.flips.length, 1);
  const f = state.flips[0];
  assert.equal(f.billing_source, "shopcx");
  assert.equal(f.shopify_contract_id, "99001");
  assert.equal(f.migrated_from_contract_id, "27000000001");
  assert.equal(f.status, "active");
  assert.equal(f.pause_resume_at, null, "a revived sub drops its auto-resume");
  assert.equal(f.next_billing_date, "2026-10-27T12:00:00.000Z");
  assert.equal(state.row.shopcx_revive_contract_id, "99001");
  // Revive creates ACTIVE even though the source row is paused.
  assert.equal(((state.lastInput as { contract: { status: string } }).contract).status, "ACTIVE");
});

test("idempotency: a second revive reuses the first contract — no second create", async () => {
  const { deps, state } = fakeDeps(mirrorRow());
  const a = await buildShopcxFromMirror(WS, SUB, "resume", {}, deps);
  const b = await buildShopcxFromMirror(WS, SUB, "resume", {}, deps);
  assert.equal(state.creates, 1);
  assert.ok(a.ok && b.ok);
  assert.equal((b as Extract<ReviveResult, { ok: true }>).contractId, (a as Extract<ReviveResult, { ok: true }>).contractId);
  assert.equal((b as Extract<ReviveResult, { ok: true }>).reused, true);
  assert.equal((b as Extract<ReviveResult, { ok: true }>).flipped, false);
});

test("idempotency: two CONCURRENT revives create exactly one contract", async () => {
  const { deps, state } = fakeDeps(mirrorRow());
  const [a, b] = await Promise.all([
    buildShopcxFromMirror(WS, SUB, "resume", {}, deps),
    buildShopcxFromMirror(WS, SUB, "resume", {}, deps),
  ]);
  assert.equal(state.creates, 1, "the claim must stop the second create");
  const okOnes = [a, b].filter((r) => r.ok);
  assert.ok(okOnes.length >= 1);
  const loser = [a, b].find((r) => !r.ok || (r.ok && r.reused));
  assert.ok(loser, "one of the two must lose the claim");
  if (loser && !loser.ok) assert.equal(loser.reason, "in_progress");
});

test("idempotency: a contract recorded by a crashed attempt is ADOPTED, never re-created", async () => {
  const { deps, state } = fakeDeps(mirrorRow({ shopcx_revive_contract_id: "88001", shopcx_revive_claimed_at: "2026-10-26T14:00:00Z" }));
  const r = await buildShopcxFromMirror(WS, SUB, "resume", {}, deps);
  assert.equal(r.ok, true);
  assert.equal(state.creates, 0);
  assert.equal((r as Extract<ReviveResult, { ok: true }>).contractId, "88001");
  assert.equal(state.flips[0].shopify_contract_id, "88001");
});

test("idempotency: a FRESH claim held by someone else → in_progress, no create", async () => {
  const { deps, state } = fakeDeps(mirrorRow({ shopcx_revive_claimed_at: "2026-10-26T14:58:00Z" }));
  const r = await buildShopcxFromMirror(WS, SUB, "resume", {}, deps);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "in_progress");
  assert.equal(state.creates, 0);
});

test("idempotency: a STALE claim with a lost-response contract on Shopify adopts it instead of duplicating", async () => {
  const { deps, state } = fakeDeps(mirrorRow({ shopcx_revive_claimed_at: "2026-10-26T13:00:00Z" }), {
    findOrphans: async () => [{ id: "gid://shopify/SubscriptionContract/77001" }],
  });
  const r = await buildShopcxFromMirror(WS, SUB, "resume", {}, deps);
  assert.equal(r.ok, true);
  assert.equal(state.creates, 0);
  assert.equal((r as Extract<ReviveResult, { ok: true }>).contractId, "77001");
});

test("refusal: no usable card → needs_payment_method, nothing created or claimed", async () => {
  for (const setup of [
    { methods: [] as PaymentMethod[] },
    { methods: [EXPIRED] },
    { customer: { shopify_customer_id: null, default_address: null } },
  ]) {
    const row = "customer" in setup ? mirrorRow({ shopify_customer_id: null }) : mirrorRow();
    const { deps, state } = fakeDeps(row, setup);
    const r = await buildShopcxFromMirror(WS, SUB, "resume", {}, deps);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "needs_payment_method");
    assert.equal(state.creates, 0);
    assert.equal(state.claims, 0);
  }
});

test("refusal: no complete address on the row or the customer → needs_address (typed, with missing fields)", async () => {
  const { deps, state } = fakeDeps(mirrorRow({ shipping_address: null }), {
    customer: { shopify_customer_id: "7000001", default_address: { address1: "1 Main" } },
  });
  const r = await buildShopcxFromMirror(WS, SUB, "resume", {}, deps);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "needs_address");
  assert.ok(!r.ok && r.missing?.includes("zip"));
  assert.equal(state.creates, 0);
});

test("address fallback: a cancelled row without an address revives with the customer's default", async () => {
  const { deps, state } = fakeDeps(mirrorRow({ status: "cancelled", next_billing_date: null, shipping_address: null }), {
    customer: { shopify_customer_id: "7000001", default_address: { address1: "9 Elm", city: "Reno", country_code: "US", zip: "89501", last_name: "Hopper" } },
  });
  const r = await buildShopcxFromMirror(WS, SUB, "resume", {}, deps);
  assert.equal(r.ok, true);
  const c = (state.lastInput as { contract: Record<string, any>; nextBillingDate: string });
  assert.equal(c.contract.deliveryMethod.shipping.address.city, "Reno");
  assert.equal(c.nextBillingDate, "2026-10-27T15:00:00.000Z", "no date on a cancelled row → tomorrow");
});

test("refusal: a CHANGE on a cancelled sub never resurrects it", async () => {
  const { deps, state } = fakeDeps(mirrorRow({ status: "cancelled" }));
  const r = await buildShopcxFromMirror(WS, SUB, "change", {}, deps);
  assert.equal(!r.ok && r.reason, "subscription_cancelled");
  assert.equal(state.creates, 0);
});

// ── ensureShopcxEngine routing ──────────────────────────────────────────────────────────────

function ensureDeps(retired: boolean, engine: "internal" | "shopcx" | "appstle", build?: EnsureDeps["build"]) {
  const calls = { resolveLive: 0, resolveEngine: 0, local: [] as string[], build: [] as string[] };
  const deps: EnsureDeps = {
    isRetired: async () => retired,
    resolveLive: async (_ws, id) => { calls.resolveLive++; return id; },
    resolveEngine: async () => { calls.resolveEngine++; return engine; },
    findSubscriptionId: async () => SUB,
    applyLocalStatus: async (_ws, _id, action) => { calls.local.push(action); },
    build: build ?? (async (_ws, _sub, intent) => {
      calls.build.push(intent);
      return { ok: true, contractId: "99001", reused: false, flipped: true, status: "active", nextBillingDate: null };
    }),
  };
  return { deps, calls };
}

test("ensure: switch OFF → untouched passthrough, no engine lookup, no build (production unchanged)", async () => {
  for (const intent of ["cancel", "pause", "resume", "change"] as const) {
    const { deps, calls } = ensureDeps(false, "appstle");
    const r = await ensureShopcxEngine(WS, "27000000001", intent, {}, deps);
    assert.deepEqual(r, { ok: true, contractId: "27000000001", engine: null, built: false, handledLocally: false });
    assert.equal(calls.resolveLive + calls.resolveEngine + calls.build.length + calls.local.length, 0);
  }
});

test("ensure: switch ON, non-Appstle engine → passthrough with that engine", async () => {
  for (const engine of ["internal", "shopcx"] as const) {
    const { deps, calls } = ensureDeps(true, engine);
    const r = await ensureShopcxEngine(WS, "c1", "change", {}, deps);
    assert.deepEqual(r, { ok: true, contractId: "c1", engine, built: false, handledLocally: false });
    assert.equal(calls.build.length, 0);
  }
});

test("ensure: switch ON, Appstle cancel/pause → our row only, flagged handledLocally (no vendor, no build)", async () => {
  for (const intent of ["cancel", "pause"] as const) {
    const { deps, calls } = ensureDeps(true, "appstle");
    const r = await ensureShopcxEngine(WS, "27000000001", intent, { cancelReason: "too much" }, deps);
    assert.deepEqual(r, { ok: true, contractId: "27000000001", engine: "appstle", built: false, handledLocally: true });
    assert.deepEqual(calls.local, [intent]);
    assert.equal(calls.build.length, 0);
  }
});

test("ensure: switch ON, Appstle revive/change → built on ShopCX, contract id rebound, engine shopcx", async () => {
  for (const intent of ["resume", "change"] as const) {
    const { deps, calls } = ensureDeps(true, "appstle");
    const r = await ensureShopcxEngine(WS, "27000000001", intent, {}, deps);
    assert.deepEqual(r, { ok: true, contractId: "99001", engine: "shopcx", built: true, handledLocally: false });
    assert.deepEqual(calls.build, [intent]);
  }
});

test("ensure: a typed build refusal propagates (never a silent success)", async () => {
  const { deps } = ensureDeps(true, "appstle", async () => ({ ok: false, reason: "needs_payment_method", error: "no card" }));
  const r = await ensureShopcxEngine(WS, "27000000001", "resume", {}, deps);
  assert.deepEqual(r, { ok: false, reason: "needs_payment_method", error: "no card" });
});

test("ensure + build end-to-end with fakes: a retired-Appstle resume lands on ShopCX with zero Appstle calls", async () => {
  const { deps: rdeps, state } = fakeDeps(mirrorRow());
  const { deps } = ensureDeps(true, "appstle", (ws, sub, intent, opts) => buildShopcxFromMirror(ws, sub, intent, opts, rdeps));
  const r = await ensureShopcxEngine(WS, "27000000001", "resume", {}, deps);
  assert.equal(r.ok && r.engine, "shopcx");
  assert.equal(r.ok && r.contractId, "99001");
  assert.equal(state.row.billing_source, "shopcx");
  assert.equal(fetchCalls.length, 0);
});
