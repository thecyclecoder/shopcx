/**
 * hero-product-advertising-gate Phase 2 verification — Cleo's DR-content product selection
 * (the enumeration that decides which product a teardown → dr-content blueprint targets)
 * excludes attachment SKUs. A teardown whose keywords match an attachment SKU (e.g. Tumbler)
 * MUST return no target, so no `dr-content` job is dispatched for it.
 *
 *   npm run test:cleo-blueprint-gate
 *   (= tsx --test src/lib/cleo-blueprint.gate.test.ts)
 *
 * We exercise the PURE matcher over an already-gated product list — the exact list
 * listActiveProducts would return post-gate. That proves the fix's contract without a
 * Supabase double: if the gate strips attachment SKUs from the input list, the matcher can
 * never pick one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { matchProductToTeardown, type ProductForMatch } from "./cleo-blueprint";
import type { TeardownRecipe } from "./research-urls";

const HERO_COFFEE: ProductForMatch = { id: "prod-hero-coffee", title: "Amazing Coffee", handle: "amazing-coffee" };
const ATTACHMENT_TUMBLER: ProductForMatch = { id: "prod-tumbler", title: "Superfoods Tumbler", handle: "superfoods-tumbler" };
const ATTACHMENT_MIXER: ProductForMatch = { id: "prod-mixer", title: "Handheld Drink Mixer", handle: "handheld-drink-mixer" };

const TUMBLER_TEARDOWN: Pick<import("./research-urls").ResearchUrl, "brand" | "teardown"> = {
  brand: "Owala",
  teardown: {
    funnel_type: "advertorial",
    strategy: "compact insulated tumbler for everyday hydration",
    transferable_pattern: "tumbler mug drink container everyday",
  } as TeardownRecipe,
};

const COFFEE_TEARDOWN: Pick<import("./research-urls").ResearchUrl, "brand" | "teardown"> = {
  brand: "Ryze",
  teardown: {
    funnel_type: "advertorial",
    strategy: "mushroom coffee blend for cognitive lift",
    transferable_pattern: "coffee morning energy focus",
  } as TeardownRecipe,
};

test("with the gate applied upstream (advertised-only list), a tumbler teardown matches NOTHING — Cleo skips the blueprint", () => {
  // The gate has already stripped attachment SKUs — the list Cleo sees is heroes only.
  const gatedProducts: ProductForMatch[] = [HERO_COFFEE];
  const match = matchProductToTeardown(TUMBLER_TEARDOWN, gatedProducts);
  assert.equal(match, null, "no hero product matches a tumbler teardown → no dr-content job dispatch");
});

test("without the gate, the SAME tumbler teardown would incorrectly match the attachment tumbler (the leak we're closing)", () => {
  // Simulates the pre-Phase-2 state: attachments in the enumeration → they get matched.
  const ungatedProducts: ProductForMatch[] = [HERO_COFFEE, ATTACHMENT_TUMBLER, ATTACHMENT_MIXER];
  const match = matchProductToTeardown(TUMBLER_TEARDOWN, ungatedProducts);
  assert.notEqual(match, null, "pre-gate: tumbler teardown would target an attachment SKU (the parked-DR-content leak)");
  assert.equal(match?.id, ATTACHMENT_TUMBLER.id, "and specifically the tumbler — proves the gate closes THIS leak");
});

test("with the gate, a coffee teardown still matches the hero coffee product (gate must not over-filter)", () => {
  const gatedProducts: ProductForMatch[] = [HERO_COFFEE];
  const match = matchProductToTeardown(COFFEE_TEARDOWN, gatedProducts);
  assert.equal(match?.id, HERO_COFFEE.id, "hero coffee still wins its teardown when the gate is applied");
});
