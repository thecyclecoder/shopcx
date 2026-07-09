/**
 * Unit tests for the Phase-2 move-replacement offer SDK — Phase 2 of
 * docs/brain/specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend.md.
 *
 * The spec pins three verifications on the SDK's behavior:
 *   - A high-LTV moved customer with a recent shipped order is offered a replacement to the
 *     newly-validated address (offerMoveReplacementIfEligible returns offered:true; the
 *     pending offer lands on tickets.playbook_context; an outbound customer-visible
 *     ticket_message is inserted).
 *   - Accepting the offer creates a $0 replacement whose shipping address is the validated new
 *     address — NOT the old one, NOT re-asked (acceptMoveReplacementOffer dispatches
 *     issueReplacement with shippingAddress = the stored validated address; the pending
 *     offer is cleared).
 *   - A non-eligible customer gets the address update without the replacement offer (the
 *     helper returns offered:false with reason 'not_eligible'; no message is written).
 *
 * Exercised against in-memory Supabase stubs — no network, no DB. Run:
 *   npx tsx --test src/lib/move-replacement-offer.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MOVE_REPLACEMENT_ELIGIBILITY_LTV_CENTS,
  MOVE_REPLACEMENT_ELIGIBILITY_ORDER_COUNT,
  MOVE_REPLACEMENT_RECENT_ORDER_WINDOW_DAYS,
  acceptMoveReplacementOffer,
  composeMoveReplacementOfferMessage,
  evaluateMoveReplacementEligibility,
  findRecentEligibleOrderForMoveReplacement,
  looksLikeMoveReplacementAcceptance,
  offerMoveReplacementIfEligible,
  type PendingMoveReplacementOffer,
  type ValidatedNewAddress,
} from "./move-replacement-offer";

const WS = "00000000-0000-0000-0000-0000000000ws";
const TID = "11111111-1111-1111-1111-111111111111";
const CID = "22222222-2222-2222-2222-222222222222";

const OLD_ADDRESS = {
  address1: "1 Old Street",
  city: "Oldtown",
  province: "CA",
  zip: "90001",
  country: "US",
};

const NEW_ADDRESS: ValidatedNewAddress = {
  street1: "1 New Street",
  street2: "Apt 4",
  city: "Newtown",
  state: "CA",
  zip: "90210",
  country: "US",
};

// ── Pure-judge tests ──

test("evaluateMoveReplacementEligibility: LTV ≥ threshold OR total_orders ≥ threshold → eligible", () => {
  assert.equal(
    evaluateMoveReplacementEligibility({ ltv_cents: MOVE_REPLACEMENT_ELIGIBILITY_LTV_CENTS, total_orders: 0 })
      .eligible,
    true,
    "LTV at threshold clears",
  );
  assert.equal(
    evaluateMoveReplacementEligibility({ ltv_cents: 0, total_orders: MOVE_REPLACEMENT_ELIGIBILITY_ORDER_COUNT })
      .eligible,
    true,
    "total_orders at threshold clears",
  );
  assert.equal(
    evaluateMoveReplacementEligibility({ ltv_cents: 999_999, total_orders: 42 }).eligible,
    true,
    "high on both clears",
  );
});

test("evaluateMoveReplacementEligibility: below BOTH thresholds → not eligible with reason echoed", () => {
  const verdict = evaluateMoveReplacementEligibility({
    ltv_cents: MOVE_REPLACEMENT_ELIGIBILITY_LTV_CENTS - 1,
    total_orders: MOVE_REPLACEMENT_ELIGIBILITY_ORDER_COUNT - 1,
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "below_ltv_and_order_count_thresholds");
});

test("evaluateMoveReplacementEligibility: negative / NaN input coerces to zero, still non-eligible", () => {
  // The helper is expected to be safe against denormalized DB values (nulls upstream).
  const verdict = evaluateMoveReplacementEligibility({
    ltv_cents: -50,
    total_orders: Number.NaN as unknown as number,
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.ltv_cents, 0);
  assert.equal(verdict.total_orders, 0);
});

test("composeMoveReplacementOfferMessage: names the order and quotes the validated new address (no markdown)", () => {
  const msg = composeMoveReplacementOfferMessage("1234", NEW_ADDRESS);
  assert.match(msg, /1234/);
  assert.match(msg, /1 New Street/);
  assert.match(msg, /Apt 4/);
  assert.match(msg, /Newtown, CA 90210/);
  assert.match(msg, /free replacement/i);
  assert.doesNotMatch(msg, /[*_`#]/, "no markdown");
});

// ── Acceptance detector ──

test("looksLikeMoveReplacementAcceptance: yes / please / sure / do it → true", () => {
  for (const s of ["yes", "yes please", "Yeah, do it", "Sure, send it", "please send", "go ahead", "sounds good"]) {
    assert.equal(looksLikeMoveReplacementAcceptance(s), true, `expected accept: ${s}`);
  }
});

test("looksLikeMoveReplacementAcceptance: no / no thanks / what would it cost → false", () => {
  for (const s of ["no", "no thanks", "Not now", "what would it cost?", "", "   ", "why?"]) {
    assert.equal(looksLikeMoveReplacementAcceptance(s), false, `expected reject: ${s}`);
  }
});

// ── Recent-order finder ──

function isoDaysAgo(n: number): string {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString();
}

interface FakeOrder {
  id: string;
  order_number: string;
  workspace_id: string;
  customer_id: string;
  created_at: string;
  shipping_address: Record<string, unknown> | null;
  line_items: unknown;
  shopify_order_id: string | null;
}

function makeRecentOrderAdmin(orders: FakeOrder[]) {
  const state = orders.slice();
  function ordersBuilder() {
    const filters: Record<string, unknown> = {};
    let gteCreatedAt: string | null = null;
    let notNullShopifyId = false;
    let desc = false;
    let limitN = Infinity;
    const builder = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      gte(col: string, val: unknown) {
        if (col === "created_at") gteCreatedAt = String(val);
        return builder;
      },
      not(col: string, op: string, val: unknown) {
        if (col === "shopify_order_id" && op === "is" && val === null) notNullShopifyId = true;
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        if (col === "created_at") desc = opts?.ascending === false;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      maybeSingle() {
        let matches = state.filter((o) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((o as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          if (gteCreatedAt && o.created_at < gteCreatedAt) return false;
          if (notNullShopifyId && o.shopify_order_id === null) return false;
          return true;
        });
        matches = matches.sort((a, b) =>
          desc ? b.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b.created_at),
        );
        matches = matches.slice(0, limitN);
        return Promise.resolve({ data: matches[0] ?? null, error: null });
      },
    };
    return builder;
  }
  return {
    from(t: string) {
      if (t === "orders") return ordersBuilder();
      throw new Error(`unexpected table: ${t}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

test("findRecentEligibleOrderForMoveReplacement: returns the most-recent order within the window with a shopify id", async () => {
  const admin = makeRecentOrderAdmin([
    { id: "o-old", order_number: "1000", workspace_id: WS, customer_id: CID, created_at: isoDaysAgo(60), shipping_address: OLD_ADDRESS, line_items: [], shopify_order_id: "shop-1000" },
    { id: "o-mid", order_number: "1200", workspace_id: WS, customer_id: CID, created_at: isoDaysAgo(10), shipping_address: OLD_ADDRESS, line_items: [{ variant_id: "v-1", quantity: 2, title: "Coffee" }], shopify_order_id: "shop-1200" },
    { id: "o-recent-no-shopify", order_number: "1300", workspace_id: WS, customer_id: CID, created_at: isoDaysAgo(3), shipping_address: OLD_ADDRESS, line_items: [], shopify_order_id: null },
  ]);
  const found = await findRecentEligibleOrderForMoveReplacement(admin, WS, CID);
  assert.ok(found, "expected a match");
  assert.equal(found!.id, "o-mid", "most-recent-within-window with a shopify id");
  assert.equal(found!.order_number, "1200");
  assert.equal(found!.line_items.length, 1);
});

test("findRecentEligibleOrderForMoveReplacement: no order in the window → null", async () => {
  const admin = makeRecentOrderAdmin([
    { id: "o-old", order_number: "1000", workspace_id: WS, customer_id: CID, created_at: isoDaysAgo(MOVE_REPLACEMENT_RECENT_ORDER_WINDOW_DAYS + 5), shipping_address: OLD_ADDRESS, line_items: [], shopify_order_id: "shop-1000" },
  ]);
  const found = await findRecentEligibleOrderForMoveReplacement(admin, WS, CID);
  assert.equal(found, null);
});

// ── offerMoveReplacementIfEligible / acceptMoveReplacementOffer ──

interface FakeCustomer {
  id: string;
  workspace_id: string;
  ltv_cents: number;
  total_orders: number;
  shopify_customer_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

interface FakeTicket {
  id: string;
  workspace_id: string;
  playbook_context: Record<string, unknown>;
}

interface FakeMessage {
  ticket_id: string;
  direction: string;
  visibility: string;
  author_type: string;
  body: string;
  sent_at?: string;
}

interface FullSeed {
  customers?: FakeCustomer[];
  tickets?: FakeTicket[];
  orders?: FakeOrder[];
}

function makeFullAdmin(seed: FullSeed) {
  const state = {
    customers: (seed.customers ?? []).map((c) => ({ ...c })),
    tickets: (seed.tickets ?? []).map((t) => ({ ...t, playbook_context: { ...t.playbook_context } })),
    orders: (seed.orders ?? []).map((o) => ({ ...o })),
    messages: [] as FakeMessage[],
  };

  function selectBuilder<T>(rows: T[]) {
    const filters: Record<string, unknown> = {};
    let gteCreatedAt: string | null = null;
    let notNullShopifyId = false;
    let desc = false;
    let limitN = Infinity;
    const builder = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      gte(col: string, val: unknown) {
        if (col === "created_at") gteCreatedAt = String(val);
        return builder;
      },
      not(col: string, op: string, val: unknown) {
        if (col === "shopify_order_id" && op === "is" && val === null) notNullShopifyId = true;
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        if (col === "created_at") desc = opts?.ascending === false;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      maybeSingle() {
        let matches = (rows as unknown as Array<Record<string, unknown>>).filter((r) => {
          for (const [k, v] of Object.entries(filters)) {
            if (r[k] !== v) return false;
          }
          if (gteCreatedAt && String(r.created_at ?? "") < gteCreatedAt) return false;
          if (notNullShopifyId && r.shopify_order_id === null) return false;
          return true;
        });
        matches = matches.sort((a, b) =>
          desc ? String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) : String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
        );
        matches = matches.slice(0, limitN);
        return Promise.resolve({ data: (matches[0] as unknown as T) ?? null, error: null });
      },
    };
    return builder;
  }

  function ticketUpdateBuilder() {
    let payload: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    const builder = {
      update(p: Record<string, unknown>) {
        payload = p;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        // Terminal — apply the update once every predicate is set. We flush on the
        // last `.eq` because Supabase's chainable builder resolves on await; the test
        // stub simulates that by returning a thenable when awaited.
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => void) {
        for (const t of state.tickets) {
          let match = true;
          for (const [k, v] of Object.entries(filters)) {
            if ((t as unknown as Record<string, unknown>)[k] !== v) match = false;
          }
          if (match && "playbook_context" in payload) {
            t.playbook_context = payload.playbook_context as Record<string, unknown>;
          }
        }
        resolve({ data: null, error: null });
      },
    };
    return builder;
  }

  function messageInsertBuilder() {
    const builder = {
      insert(row: FakeMessage) {
        state.messages.push({ ...row });
        return Promise.resolve({ data: null, error: null });
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "customers") return selectBuilder(state.customers);
      if (table === "orders") return selectBuilder(state.orders);
      if (table === "tickets") {
        // Two shapes — a read-only select (offer/accept) or an update (offer + accept).
        // Return a proxy that hands out the right builder based on the first method
        // called; both start with `.select` OR `.update`.
        const proxy = {
          select(cols: string) {
            return selectBuilder(state.tickets).select(cols);
          },
          update(p: Record<string, unknown>) {
            return ticketUpdateBuilder().update(p);
          },
        };
        return proxy as unknown as ReturnType<typeof selectBuilder>;
      }
      if (table === "ticket_messages") return messageInsertBuilder();
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { admin: admin as unknown as import("@supabase/supabase-js").SupabaseClient, state };
}

test("offer: high-LTV moved customer with a recent shipped order → offered=true, message written, pending offer stored", async () => {
  const { admin, state } = makeFullAdmin({
    customers: [
      {
        id: CID, workspace_id: WS,
        ltv_cents: 250_000, total_orders: 12,
        shopify_customer_id: "shop-cust-1", first_name: "Sam", last_name: "Buyer",
      },
    ],
    tickets: [{ id: TID, workspace_id: WS, playbook_context: {} }],
    orders: [
      { id: "o-recent", order_number: "1234", workspace_id: WS, customer_id: CID, created_at: isoDaysAgo(3), shipping_address: OLD_ADDRESS, line_items: [{ variant_id: "v-1", quantity: 2, title: "Coffee" }], shopify_order_id: "shop-1234" },
    ],
  });
  const result = await offerMoveReplacementIfEligible(admin, {
    workspace_id: WS, ticket_id: TID, customer_id: CID,
    validated_address: NEW_ADDRESS,
  });
  assert.equal(result.offered, true);
  assert.equal(result.reason, "offered");
  assert.equal(result.order?.order_number, "1234");
  assert.equal(result.ltv_cents, 250_000);
  assert.equal(state.messages.length, 1, "one outbound offer message");
  assert.equal(state.messages[0].visibility, "external");
  assert.equal(state.messages[0].direction, "outbound");
  assert.match(state.messages[0].body, /free replacement/i);
  assert.match(state.messages[0].body, /1234/);
  assert.match(state.messages[0].body, /1 New Street/);
  const pending = state.tickets[0].playbook_context.pending_move_replacement_offer as PendingMoveReplacementOffer;
  assert.ok(pending, "pending offer stored on ticket");
  assert.equal(pending.order_id, "o-recent");
  assert.equal(pending.order_number, "1234");
  assert.equal(pending.validated_address.street1, "1 New Street");
});

test("offer: non-eligible customer (below both thresholds) → offered=false, NO message written, NO pending offer stashed", async () => {
  const { admin, state } = makeFullAdmin({
    customers: [
      {
        id: CID, workspace_id: WS,
        ltv_cents: 500, total_orders: 1, // brand-new, low LTV
        shopify_customer_id: "shop-cust-1", first_name: "Sam", last_name: "Buyer",
      },
    ],
    tickets: [{ id: TID, workspace_id: WS, playbook_context: {} }],
    orders: [
      { id: "o-recent", order_number: "1234", workspace_id: WS, customer_id: CID, created_at: isoDaysAgo(3), shipping_address: OLD_ADDRESS, line_items: [], shopify_order_id: "shop-1234" },
    ],
  });
  const result = await offerMoveReplacementIfEligible(admin, {
    workspace_id: WS, ticket_id: TID, customer_id: CID,
    validated_address: NEW_ADDRESS,
  });
  assert.equal(result.offered, false);
  assert.equal(result.reason, "not_eligible");
  assert.equal(state.messages.length, 0, "no offer message on ineligible customer — no unbacked promise");
  assert.equal(state.tickets[0].playbook_context.pending_move_replacement_offer, undefined);
});

test("offer: eligible customer with NO recent order → offered=false with reason 'no_recent_order'", async () => {
  const { admin, state } = makeFullAdmin({
    customers: [
      {
        id: CID, workspace_id: WS,
        ltv_cents: 250_000, total_orders: 12,
        shopify_customer_id: "shop-cust-1", first_name: "Sam", last_name: "Buyer",
      },
    ],
    tickets: [{ id: TID, workspace_id: WS, playbook_context: {} }],
    orders: [], // no orders at all
  });
  const result = await offerMoveReplacementIfEligible(admin, {
    workspace_id: WS, ticket_id: TID, customer_id: CID,
    validated_address: NEW_ADDRESS,
  });
  assert.equal(result.offered, false);
  assert.equal(result.reason, "no_recent_order");
  assert.equal(state.messages.length, 0);
});

test("offer: an offer is already pending on the ticket → offered=false with reason 'offer_already_pending' (no double-offer)", async () => {
  const prior: PendingMoveReplacementOffer = {
    order_id: "o-old-offer", order_number: "999",
    validated_address: NEW_ADDRESS,
    offered_at: new Date().toISOString(),
    eligibility: { ltv_cents: 250_000, total_orders: 12 },
  };
  const { admin, state } = makeFullAdmin({
    customers: [
      {
        id: CID, workspace_id: WS,
        ltv_cents: 250_000, total_orders: 12,
        shopify_customer_id: "shop-cust-1", first_name: "Sam", last_name: "Buyer",
      },
    ],
    tickets: [{ id: TID, workspace_id: WS, playbook_context: { pending_move_replacement_offer: prior } }],
    orders: [
      { id: "o-recent", order_number: "1234", workspace_id: WS, customer_id: CID, created_at: isoDaysAgo(3), shipping_address: OLD_ADDRESS, line_items: [], shopify_order_id: "shop-1234" },
    ],
  });
  const result = await offerMoveReplacementIfEligible(admin, {
    workspace_id: WS, ticket_id: TID, customer_id: CID,
    validated_address: NEW_ADDRESS,
  });
  assert.equal(result.offered, false);
  assert.equal(result.reason, "offer_already_pending");
  // No duplicate message.
  assert.equal(state.messages.length, 0);
  // Prior offer preserved.
  const stillPending = state.tickets[0].playbook_context.pending_move_replacement_offer as PendingMoveReplacementOffer;
  assert.equal(stillPending.order_id, "o-old-offer");
});

test("accept: pending offer + eligible customer → issueReplacement called with the NEW validated address (not the old), pending offer cleared", async () => {
  const pending: PendingMoveReplacementOffer = {
    order_id: "o-recent", order_number: "1234",
    validated_address: NEW_ADDRESS,
    offered_at: new Date().toISOString(),
    eligibility: { ltv_cents: 250_000, total_orders: 12 },
  };
  const { admin, state } = makeFullAdmin({
    customers: [
      {
        id: CID, workspace_id: WS,
        ltv_cents: 250_000, total_orders: 12,
        shopify_customer_id: "shop-cust-1", first_name: "Sam", last_name: "Buyer",
      },
    ],
    tickets: [{ id: TID, workspace_id: WS, playbook_context: { pending_move_replacement_offer: pending } }],
    orders: [
      { id: "o-recent", order_number: "1234", workspace_id: WS, customer_id: CID, created_at: isoDaysAgo(3), shipping_address: OLD_ADDRESS, line_items: [{ variant_id: "v-1", quantity: 2, title: "Coffee" }], shopify_order_id: "shop-1234" },
    ],
  });
  let seenArgs: import("./commerce/replacement").IssueReplacementArgs | null = null;
  const result = await acceptMoveReplacementOffer(
    admin,
    { workspace_id: WS, ticket_id: TID, customer_id: CID },
    {
      issueReplacement: async (_ws, args) => {
        seenArgs = args;
        return { success: true, replacementId: "rep-1", shopifyOrderName: "#R1234" };
      },
    },
  );
  assert.equal(result.created, true);
  assert.equal(result.reason, "created");
  assert.ok(seenArgs, "issueReplacement was called");
  const dispatched = seenArgs as unknown as import("./commerce/replacement").IssueReplacementArgs;
  assert.equal(dispatched.customerId, CID);
  assert.equal(dispatched.shopifyCustomerId, "shop-cust-1");
  assert.equal(dispatched.originalOrderNumber, "1234");
  assert.equal(dispatched.shippingAddress.address1, "1 New Street", "NEW validated address, not the old one");
  assert.equal(dispatched.shippingAddress.city, "Newtown");
  assert.equal(dispatched.shippingAddress.zip, "90210");
  assert.equal(dispatched.shippingAddress.province, "CA");
  assert.equal(dispatched.shippingAddress.address2, "Apt 4");
  assert.equal(dispatched.reason, "moved_customer_save");
  assert.equal(dispatched.items.length, 1);
  assert.equal(dispatched.items[0].variantId, "v-1");
  assert.equal(dispatched.items[0].quantity, 2);
  // Pending offer cleared.
  assert.equal(state.tickets[0].playbook_context.pending_move_replacement_offer, undefined);
});

test("accept: no pending offer → created=false with reason 'no_pending_offer' (issueReplacement never called)", async () => {
  const { admin } = makeFullAdmin({
    customers: [
      {
        id: CID, workspace_id: WS,
        ltv_cents: 250_000, total_orders: 12,
        shopify_customer_id: "shop-cust-1", first_name: "Sam", last_name: "Buyer",
      },
    ],
    tickets: [{ id: TID, workspace_id: WS, playbook_context: {} }],
    orders: [],
  });
  let called = false;
  const result = await acceptMoveReplacementOffer(
    admin,
    { workspace_id: WS, ticket_id: TID, customer_id: CID },
    {
      issueReplacement: async () => {
        called = true;
        return { success: true, replacementId: "rep-1", shopifyOrderName: null };
      },
    },
  );
  assert.equal(result.created, false);
  assert.equal(result.reason, "no_pending_offer");
  assert.equal(called, false, "guarded — no replacement fired when there was no offer");
});

test("accept: issueReplacement returns success=false → created=false with reason 'issue_replacement_failed', pending offer preserved for a retry", async () => {
  const pending: PendingMoveReplacementOffer = {
    order_id: "o-recent", order_number: "1234",
    validated_address: NEW_ADDRESS,
    offered_at: new Date().toISOString(),
    eligibility: { ltv_cents: 250_000, total_orders: 12 },
  };
  const { admin, state } = makeFullAdmin({
    customers: [
      {
        id: CID, workspace_id: WS,
        ltv_cents: 250_000, total_orders: 12,
        shopify_customer_id: "shop-cust-1", first_name: "Sam", last_name: "Buyer",
      },
    ],
    tickets: [{ id: TID, workspace_id: WS, playbook_context: { pending_move_replacement_offer: pending } }],
    orders: [
      { id: "o-recent", order_number: "1234", workspace_id: WS, customer_id: CID, created_at: isoDaysAgo(3), shipping_address: OLD_ADDRESS, line_items: [{ variant_id: "v-1", quantity: 1 }], shopify_order_id: "shop-1234" },
    ],
  });
  const result = await acceptMoveReplacementOffer(
    admin,
    { workspace_id: WS, ticket_id: TID, customer_id: CID },
    {
      issueReplacement: async () => ({ success: false, replacementId: "", shopifyOrderName: null, error: "boom" }),
    },
  );
  assert.equal(result.created, false);
  assert.equal(result.reason, "issue_replacement_failed");
  assert.equal(result.error, "boom");
  // Pending offer preserved for the retry.
  const stillPending = state.tickets[0].playbook_context.pending_move_replacement_offer as PendingMoveReplacementOffer;
  assert.ok(stillPending);
  assert.equal(stillPending.order_number, "1234");
});

test("accept: customer missing shopify_customer_id → created=false with reason 'customer_missing_shopify_id'", async () => {
  const pending: PendingMoveReplacementOffer = {
    order_id: "o-recent", order_number: "1234",
    validated_address: NEW_ADDRESS,
    offered_at: new Date().toISOString(),
    eligibility: { ltv_cents: 250_000, total_orders: 12 },
  };
  const { admin } = makeFullAdmin({
    customers: [
      {
        id: CID, workspace_id: WS,
        ltv_cents: 250_000, total_orders: 12,
        shopify_customer_id: null, first_name: "Sam", last_name: "Buyer",
      },
    ],
    tickets: [{ id: TID, workspace_id: WS, playbook_context: { pending_move_replacement_offer: pending } }],
    orders: [
      { id: "o-recent", order_number: "1234", workspace_id: WS, customer_id: CID, created_at: isoDaysAgo(3), shipping_address: OLD_ADDRESS, line_items: [], shopify_order_id: "shop-1234" },
    ],
  });
  let called = false;
  const result = await acceptMoveReplacementOffer(
    admin,
    { workspace_id: WS, ticket_id: TID, customer_id: CID },
    {
      issueReplacement: async () => {
        called = true;
        return { success: true, replacementId: "rep-1", shopifyOrderName: null };
      },
    },
  );
  assert.equal(result.created, false);
  assert.equal(result.reason, "customer_missing_shopify_id");
  assert.equal(called, false);
});
