/**
 * Phase 1 of concierge-orders-never-strand-before-amplifier.
 *
 * Pins the pure `withShipToName` helper chargeOneTimeOrder uses before it stores
 * OR pushes an order to Amplifier. Ground truth: order SHOPCX583 (Randi Stier)
 * reused the customer's last order address, which carried empty firstName/
 * lastName; Amplifier 400'd the nameless ship-to and the paid order sat
 * unshipped for 28 days. The helper fills the name from the customer record when
 * the address's own name fields are blank, writing BOTH the camelCase
 * (firstName) and snake_case (first_name) keys the payloads are read under.
 *
 * Pure function, no I/O — a direct import.
 *
 * Run:
 *   npx tsx --test src/lib/one-time-charge.ship-name.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withShipToName } from "./one-time-charge";

test("blank name fields are filled from the customer record (the SHOPCX583 case)", () => {
  const out = withShipToName(
    { address1: "1 Main St", firstName: "", lastName: "", first_name: "", last_name: "" },
    { first_name: "Randi", last_name: "Stier" },
  );
  assert.equal(out.firstName, "Randi");
  assert.equal(out.lastName, "Stier");
  // snake_case keys are set too, so whichever casing the payload reads sees it.
  assert.equal(out.first_name, "Randi");
  assert.equal(out.last_name, "Stier");
});

test("whitespace-only name fields count as blank and get filled", () => {
  const out = withShipToName(
    { firstName: "   ", lastName: "\t" },
    { first_name: "Randi", last_name: "Stier" },
  );
  assert.equal(out.firstName, "Randi");
  assert.equal(out.lastName, "Stier");
  assert.equal(out.first_name, "Randi");
  assert.equal(out.last_name, "Stier");
});

test("an address with no name keys at all is populated from the customer", () => {
  const out = withShipToName({ address1: "1 Main St" }, { first_name: "Randi", last_name: "Stier" });
  assert.equal(out.firstName, "Randi");
  assert.equal(out.lastName, "Stier");
  assert.equal(out.first_name, "Randi");
  assert.equal(out.last_name, "Stier");
});

test("existing camelCase names are kept, never overwritten", () => {
  const out = withShipToName(
    { firstName: "Jo", lastName: "Doe" },
    { first_name: "Randi", last_name: "Stier" },
  );
  assert.equal(out.firstName, "Jo");
  assert.equal(out.lastName, "Doe");
});

test("existing snake_case names are kept, never overwritten", () => {
  const out = withShipToName(
    { first_name: "Jo", last_name: "Doe" },
    { first_name: "Randi", last_name: "Stier" },
  );
  assert.equal(out.first_name, "Jo");
  assert.equal(out.last_name, "Doe");
});

test("first and last are decided independently (fill one, keep the other)", () => {
  const out = withShipToName(
    { firstName: "Jo", lastName: "" },
    { first_name: "Randi", last_name: "Stier" },
  );
  assert.equal(out.firstName, "Jo");
  assert.equal(out.lastName, "Stier");
  assert.equal(out.last_name, "Stier");
});

test("a blank customer name leaves a blank address name alone (nothing to fill with)", () => {
  const out = withShipToName(
    { firstName: "", lastName: "" },
    { first_name: null, last_name: "  " },
  );
  assert.equal(out.firstName, "");
  assert.equal(out.lastName, "");
});

test("returns a copy — the input address is not mutated", () => {
  const ship: Record<string, unknown> = { firstName: "" };
  const out = withShipToName(ship, { first_name: "Randi", last_name: "Stier" });
  assert.equal(ship.firstName, "");
  assert.notEqual(out, ship);
});
