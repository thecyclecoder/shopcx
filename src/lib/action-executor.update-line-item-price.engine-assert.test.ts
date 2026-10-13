/**
 * Phase 2 of cx-agents-read-engine-price-not-override-base.
 *
 * Pins the `update_line_item_price` engine-price assertion guard: on an INTERNAL
 * sub the handler REFUSES when the action payload is missing
 * `expected_current_realized_cents`, or when the quoted figure disagrees with the
 * engine's current realized unit by more than 1¢. Prevents an agent that mis-read
 * `price_override_cents` (the pre-discount base) as the realized price from
 * "fixing" a correct sub (ticket 01f6a2e6 → 668bc5c8).
 *
 * Stubs the dynamic-imported deps via Node's module cache BEFORE requiring
 * action-executor so the handler's internal `await import(...)` calls hit the
 * stubs rather than booting real DB code.
 *
 * Run:
 *   npx tsx --test src/lib/action-executor.update-line-item-price.engine-assert.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };

function stubModule(spec: string, exports: Record<string, unknown>) {
  moduleAny._cache[require.resolve(spec)] = { exports };
}

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const SUB_ID = "22222222-2222-2222-2222-222222222222";
const CONTRACT_ID = "internal-1682046baaf94689";
const VARIANT_ID = "33333333-3333-3333-3333-333333333333";
const TICKET_ID = "44444444-4444-4444-4444-444444444444";

// The sub carries a correct 3-bag Cocoa line with a $79.95 pre-discount override base.
// The engine (resolveSubscriptionPricing stub below) returns the realized $52.77/bag — the agent
// MUST quote 5277 (±1) in `expected_current_realized_cents`, not 7995.
const subRow = {
  id: SUB_ID,
  items: [
    {
      variant_id: VARIANT_ID,
      title: "Cocoa Superfoods",
      quantity: 3,
      price_override_cents: 7995,
    },
  ],
  delivery_price_cents: 0,
  pricing_offer_id: null,
};

function makeAdmin() {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const admin = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: unknown) {
              return {
                eq(_c: string, _v: unknown) {
                  return {
                    async maybeSingle() {
                      if (table === "subscriptions") {
                        return { data: subRow, error: null };
                      }
                      return { data: null, error: null };
                    },
                  };
                },
                order() {
                  return {
                    limit() {
                      return {
                        async maybeSingle() {
                          return { data: null, error: null };
                        },
                      };
                    },
                  };
                },
                in() {
                  return {
                    order() {
                      return {
                        limit() {
                          return {
                            async maybeSingle() {
                              return { data: null, error: null };
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return { admin, inserts };
}

// Minimal stubs for the dynamic-imported deps. The guard runs AFTER detectOvercharge /
// resolveBillingSource and BEFORE subUpdateLineItemPrice — in the refusal cases we only need
// resolveBillingSource='internal' + resolveSubscriptionPricing returning the engine's realized
// price for the target variant.
stubModule("@/lib/subscription-items", {
  async subUpdateLineItemPrice() {
    throw new Error("subUpdateLineItemPrice must not be reached — guard should refuse first");
  },
});
stubModule("@/lib/subscription-overcharge", {
  async detectOvercharge() {
    return null;
  },
  async deriveRestoreBase() {
    throw new Error("deriveRestoreBase must not be reached — guard should refuse first");
  },
  isRaiseAttempt() {
    return false;
  },
});
stubModule("@/lib/internal-subscription", {
  async resolveBillingSource() {
    return "internal";
  },
});
stubModule("@/lib/pricing", {
  async resolveSubscriptionPricing() {
    return {
      lines: [
        {
          variant_id: VARIANT_ID,
          product_id: null,
          title: "Cocoa Superfoods",
          variant_title: "",
          sku: null,
          quantity: 3,
          line_id: null,
          is_gift: false,
          kind: "product",
          base_cents: 7995,
          unit_cents: 5277, // the engine price — this is what agents must quote
          break_pct: 12,
          sns_pct: 25,
          is_grandfathered: true,
        },
      ],
      product_subtotal_cents: 15831,
      product_msrp_cents: 23985,
      shipping_cents: 0,
      free_shipping: false,
      discounts: [],
    };
  },
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { directActionHandlers } = require("./action-executor") as typeof import("./action-executor");

function makeCtx() {
  const { admin, inserts } = makeAdmin();
  return {
    ctx: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      admin: admin as any,
      workspaceId: WORKSPACE_ID,
      ticketId: TICKET_ID,
      customerId: "cust-1",
      channel: "email",
      sandbox: false,
    },
    inserts,
  };
}

test("Phase 2: missing expected_current_realized_cents on an internal sub → handler refuses with a re-read instruction", async () => {
  const { ctx } = makeCtx();
  const r = await directActionHandlers.update_line_item_price(ctx, {
    type: "update_line_item_price",
    contract_id: CONTRACT_ID,
    variant_id: VARIANT_ID,
    base_price_cents: 5996, // the wrong "fix" from ticket 668bc5c8 ($59.96 base = $39.57 engine)
    // expected_current_realized_cents OMITTED — this is the gate
  });
  assert.equal(r.success, false, "handler must refuse");
  assert.match(String(r.error), /expected_current_realized_cents/i);
  assert.match(String(r.error), /getCxSubscriptions/i);
});

test("Phase 2: wrong expected_current_realized_cents (quoted the override base, not the engine price) → refused with before/after dollars", async () => {
  const { ctx } = makeCtx();
  // The agent read $79.95 as realized (the ground-truth bug) and quoted 7995.
  const r = await directActionHandlers.update_line_item_price(ctx, {
    type: "update_line_item_price",
    contract_id: CONTRACT_ID,
    variant_id: VARIANT_ID,
    base_price_cents: 5996,
    expected_current_realized_cents: 7995, // wrong — the engine actually charges 5277
  });
  assert.equal(r.success, false, "handler must refuse on a mismatched quote");
  assert.match(String(r.error), /you believe/i);
  assert.ok(
    String(r.error).includes("$79.95") || String(r.error).includes("79.95"),
    `error must name the agent's quoted price: ${r.error}`,
  );
  assert.ok(
    String(r.error).includes("$52.77") || String(r.error).includes("52.77"),
    `error must name the engine's actual realized price: ${r.error}`,
  );
  // Teaching line — override is NOT realized.
  assert.match(String(r.error), /price_override_cents is the PRE-DISCOUNT base, not realized/i);
});
