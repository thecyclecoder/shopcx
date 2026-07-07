/**
 * Phase 2 audit — assert every order-creating action in the executor
 * routes through `resolveCustomerShippingAddress` and that none of them
 * still reads a cited order's `shipping_address` off the `orders` table
 * to set a destination.
 *
 * A grep-style audit is the right shape here: the bug class the spec is
 * closing is "a NEW handler grows the same stale-snapshot pattern" —
 * catching it in a test that reads the executor source is exactly the
 * regression pin. Running the handlers end-to-end would require mocking
 * every downstream vendor call — the pattern the audit checks is
 * static, so read the source instead.
 *
 * Run:
 *   npx tsx --test src/lib/customer-shipping-address.audit.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXECUTOR = readFileSync(
  join(process.cwd(), "src/lib/action-executor.ts"),
  "utf8",
);

/** Extract the body of a named directActionHandlers key. Naive but
 *  sufficient for our purpose — the handlers in this file all use the
 *  arrow-fn `<name>: async (ctx, p) => { ... },` shape. */
function extractHandlerBody(name: string): string {
  const startPattern = new RegExp(`\\n  ${name}:\\s*async\\s*\\(`);
  const m = startPattern.exec(EXECUTOR);
  if (!m) throw new Error(`handler ${name} not found`);
  // Walk forward brace-balanced from the first { after the arrow.
  const idx = EXECUTOR.indexOf("=> {", m.index);
  if (idx < 0) throw new Error(`no => { after ${name}`);
  let depth = 0;
  let i = idx + 3; // point at the {
  for (; i < EXECUTOR.length; i++) {
    const c = EXECUTOR[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return EXECUTOR.slice(idx, i + 1);
    }
  }
  throw new Error(`unterminated handler body for ${name}`);
}

const ORDER_CREATING_HANDLERS = [
  "create_replacement_order",
  "create_order",
  "dollar_replacement",
];

test("every order-creating handler imports resolveCustomerShippingAddress (no more inline priority-chain forks)", () => {
  for (const name of ORDER_CREATING_HANDLERS) {
    const body = extractHandlerBody(name);
    assert.match(
      body,
      /resolveCustomerShippingAddress/,
      `${name} must delegate to resolveCustomerShippingAddress`,
    );
  }
});

test("no order-creating handler reads .select(\"shipping_address\") off the orders table to build a destination", () => {
  for (const name of ORDER_CREATING_HANDLERS) {
    const body = extractHandlerBody(name);
    // The pattern the spec is closing: a handler that queries orders
    // and pulls shipping_address to hand to a downstream shipping call.
    // resolveCustomerShippingAddress owns that read now; a survivor is
    // a regression.
    assert.doesNotMatch(
      body,
      /\.select\([^)]*shipping_address[^)]*\)[^\n]*\n[\s\S]*?\.from\(["']orders["']\)/,
      `${name} may not build a destination from orders.shipping_address — go through resolveCustomerShippingAddress`,
    );
    assert.doesNotMatch(
      body,
      /\.from\(["']orders["']\)[\s\S]*?\.select\([^)]*shipping_address/,
      `${name} may not read orders.shipping_address to set a shipping destination — go through resolveCustomerShippingAddress`,
    );
  }
});

test("every order-creating handler emits the divergence note when the cited order disagrees", () => {
  for (const name of ORDER_CREATING_HANDLERS) {
    const body = extractHandlerBody(name);
    // resolved.diverged is the signal we log; every handler must
    // surface it so the operator sees the "customer moved" case that
    // the 49ddd6c4 ticket flew past silently.
    assert.match(
      body,
      /diverged/,
      `${name} must handle the resolved.diverged signal`,
    );
    assert.match(
      body,
      /formatDivergenceNote/,
      `${name} must format the divergence note when diverged fires`,
    );
  }
});

test("commerce/order.ts createOrder still accepts shipping_address (the resolver's output is what we pass in)", () => {
  const orderSdk = readFileSync(
    join(process.cwd(), "src/lib/commerce/order.ts"),
    "utf8",
  );
  assert.match(orderSdk, /shipping_address\?:/, "createOrder input must still expose shipping_address");
});
