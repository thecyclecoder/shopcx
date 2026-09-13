/**
 * Unit tests for the createSubscription variant-hydration gate — pins the
 * refusal path that closes ticket c13fbad1 (Kristy Teague's bundled split).
 *
 * The pre-fix `createSubscription` accepted an item with only `variant_id` set
 * and persisted `{title:"", product_id:null, price_override_cents:null}` — a
 * "ghost" line that would bill $0 or error at renewal. The fix hydrates each
 * item's catalog metadata via `deps.resolveVariant` BEFORE persistence and
 * refuses `{success:false, error}` when any variant is unresolvable, so the
 * assisted-purchase caller escalates instead of shipping a malformed sub.
 *
 * Pure — the injected `deps.resolveVariant` stubs the DB. No Supabase.
 *
 * Run:
 *   npm run test:commerce-subscription-create-hydrate
 *   (= tsx --test src/lib/commerce/subscription.create-hydrate.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  hydrateCreateSubscriptionItems,
  type CreateSubscriptionItem,
  type CreateSubscriptionDeps,
} from "./subscription";
import type { ResolvedVariant } from "@/lib/internal-subscription";

// ── hydrateCreateSubscriptionItems (pure) ─────────────────────────────

function resolved(id: string, overrides: Partial<ResolvedVariant> = {}): ResolvedVariant {
  return {
    id,
    product_id: overrides.product_id ?? `p-${id}`,
    title: overrides.title ?? `Product ${id}`,
    variant_title: overrides.variant_title ?? "Default",
    sku: overrides.sku ?? `SKU-${id}`,
  };
}

test("hydrateCreateSubscriptionItems: variant_id-only input gets product_id/title/variant_title/sku filled from the resolver", () => {
  const items: CreateSubscriptionItem[] = [{ variant_id: "88f725ad" }];
  const map = new Map([["88f725ad", resolved("88f725ad", { title: "Amazing Creamer", variant_title: "Vanilla" })]]);
  const r = hydrateCreateSubscriptionItems(items, map);
  assert.equal(r.success, true);
  if (!r.success) return;
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].variant_id, "88f725ad");
  assert.equal(r.items[0].product_id, "p-88f725ad");
  assert.equal(r.items[0].title, "Amazing Creamer");
  assert.equal(r.items[0].variant_title, "Vanilla");
  assert.equal(r.items[0].sku, "SKU-88f725ad");
});

test("hydrateCreateSubscriptionItems: unresolvable variant → refusal with the variant listed in `missing`", () => {
  const items: CreateSubscriptionItem[] = [{ variant_id: "not-a-real-variant" }];
  const map = new Map<string, ResolvedVariant | null>([["not-a-real-variant", null]]);
  const r = hydrateCreateSubscriptionItems(items, map);
  assert.equal(r.success, false);
  if (r.success) return;
  assert.deepEqual(r.missing, ["not-a-real-variant"]);
  assert.match(r.error, /could not be resolved/);
  assert.match(r.error, /not-a-real-variant/);
});

test("hydrateCreateSubscriptionItems: any unresolvable variant refuses the whole batch (all-or-nothing)", () => {
  // Kristy's split: two items, one resolvable, one unresolvable — must NOT
  // persist a half-batch. The pre-fix create wrote the malformed ghost even
  // when the other line was fine.
  const items: CreateSubscriptionItem[] = [
    { variant_id: "c1e1e38d" }, // resolvable (Coffee K-Cups Cocoa)
    { variant_id: "unknown" },  // not in catalog
  ];
  const map = new Map<string, ResolvedVariant | null>([
    ["c1e1e38d", resolved("c1e1e38d")],
    ["unknown", null],
  ]);
  const r = hydrateCreateSubscriptionItems(items, map);
  assert.equal(r.success, false);
  if (r.success) return;
  assert.deepEqual(r.missing, ["unknown"]);
});

test("hydrateCreateSubscriptionItems: caller-supplied product_id/title/sku pass through (resolver only fills blanks)", () => {
  const items: CreateSubscriptionItem[] = [{
    variant_id: "v1",
    product_id: "caller-supplied-p",
    title: "Caller Title",
    sku: "CALLER-SKU",
  }];
  const map = new Map([["v1", resolved("v1", { title: "Resolver Title", sku: "RESOLVER-SKU" })]]);
  const r = hydrateCreateSubscriptionItems(items, map);
  assert.equal(r.success, true);
  if (!r.success) return;
  assert.equal(r.items[0].product_id, "caller-supplied-p");
  assert.equal(r.items[0].title, "Caller Title");
  assert.equal(r.items[0].sku, "CALLER-SKU");
});

test("hydrateCreateSubscriptionItems: legacy Shopify id on input is normalized to the canonical UUID from the resolver", () => {
  // resolveVariant accepts a Shopify id and returns the canonical UUID; the
  // hydrated item MUST carry the UUID so internal ops (matching by variant_id)
  // don't miss on the mismatched shape.
  const items: CreateSubscriptionItem[] = [{ variant_id: "999888777" /* shopify id */ }];
  const map = new Map([["999888777", resolved("11111111-2222-3333-4444-555555555555")]]);
  const r = hydrateCreateSubscriptionItems(items, map);
  assert.equal(r.success, true);
  if (!r.success) return;
  assert.equal(r.items[0].variant_id, "11111111-2222-3333-4444-555555555555");
});

test("hydrateCreateSubscriptionItems: preserves quantity + is_gift + price_override_cents from input", () => {
  const items: CreateSubscriptionItem[] = [{
    variant_id: "v1",
    quantity: 3,
    is_gift: true,
    price_override_cents: 0,
  }];
  const map = new Map([["v1", resolved("v1")]]);
  const r = hydrateCreateSubscriptionItems(items, map);
  assert.equal(r.success, true);
  if (!r.success) return;
  assert.equal(r.items[0].quantity, 3);
  assert.equal(r.items[0].is_gift, true);
  assert.equal(r.items[0].price_override_cents, 0);
});

test("hydrateCreateSubscriptionItems: empty variant_id is refused (never allowed to persist)", () => {
  const items: CreateSubscriptionItem[] = [{ variant_id: "" }];
  const r = hydrateCreateSubscriptionItems(items, new Map());
  assert.equal(r.success, false);
  if (r.success) return;
  assert.match(r.error, /empty variant_id/);
});

// ── Sanity: the CreateSubscriptionDeps interface is exported ──────────

test("CreateSubscriptionDeps interface is exported (assert on a value that satisfies its shape)", () => {
  const deps: CreateSubscriptionDeps = {
    async resolveVariant(_id: string) {
      return null;
    },
  };
  assert.equal(typeof deps.resolveVariant, "function");
});
