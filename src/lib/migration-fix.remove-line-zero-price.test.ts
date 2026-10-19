/**
 * remove_line by `shopify_variant_id` on an unflagged $0 one-time gift that RESOLVED to a real
 * catalog variant (ground truth: Handheld Drink Mixer ASC-MIX-1, Appstle contract 27818131629 —
 * CEO declined a price_override_cents=0 lock on audit cd3bd0e1 2026-10-19 and removed the line).
 * The migrated item carries a catalog UUID in items[].variant_id, so a raw Shopify-id match used
 * to miss it. The relaxation matches the catalog UUID too — but ONLY when the Appstle snapshot
 * price for that Shopify id was $0 (verified against the stored snapshot, never a caller flag);
 * a PAID line by Shopify id stays protected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyMigrationFix } from "./migration-fix";

type State = {
  subItems: Array<Record<string, unknown>>;
  snapshotLines: Array<Record<string, unknown>>;
  variantId: string | null; // product_variants.id resolved for the Shopify id
};

function makeAdmin(state: State, captured: { items?: Array<Record<string, unknown>> }) {
  const read = (table: string) => {
    const q: Record<string, unknown> = {
      _f: {} as Record<string, unknown>,
      eq(c: string, v: unknown) {
        (q._f as Record<string, unknown>)[c] = v;
        return q;
      },
      async maybeSingle() {
        if (table === "subscriptions") return { data: { id: (q._f as Record<string, unknown>).id, items: state.subItems } };
        if (table === "appstle_contract_snapshots") return { data: { lines: state.snapshotLines } };
        if (table === "product_variants") return { data: state.variantId ? { id: state.variantId } : null };
        return { data: null };
      },
    };
    return q;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    from(table: string) {
      return {
        select: () => read(table),
        update(payload: Record<string, unknown>) {
          return {
            async eq() {
              if (table === "subscriptions") captured.items = payload.items as Array<Record<string, unknown>>;
              return { error: null };
            },
          };
        },
      };
    },
  } as any;
}

const AUDIT = { workspace_id: "ws1", subscription_id: "sub1", appstle_contract_id: "27818131629" };
const MIXER = { variant_id: "uuid-mixer", title: "Handheld Drink Mixer", quantity: 1 };
const COFFEE = { variant_id: "uuid-coffee", title: "Coffee", quantity: 1 };

test("catalog-resolved $0 line removed by shopify_variant_id (snapshot price was $0)", async () => {
  const captured: { items?: Array<Record<string, unknown>> } = {};
  const admin = makeAdmin(
    {
      subItems: [{ ...MIXER }, { ...COFFEE }],
      snapshotLines: [{ variant_id: "44444", current_price_cents: 0, discounted_total_cents: 0 }],
      variantId: "uuid-mixer",
    },
    captured,
  );
  const res = await applyMigrationFix(admin, AUDIT, { fix_kind: "remove_line", payload: { shopify_variant_id: "44444" } });
  assert.equal(res.ok, true);
  assert.match(res.detail, /removed 1/);
  assert.deepEqual(captured.items, [{ ...COFFEE }]);
});

test("PAID catalog line is NOT removed by shopify_variant_id (snapshot price > $0 → guard holds)", async () => {
  const captured: { items?: Array<Record<string, unknown>> } = {};
  const admin = makeAdmin(
    {
      subItems: [{ ...MIXER }, { ...COFFEE }],
      snapshotLines: [{ variant_id: "44444", current_price_cents: 1496, discounted_total_cents: 1496 }],
      variantId: "uuid-mixer",
    },
    captured,
  );
  const res = await applyMigrationFix(admin, AUDIT, { fix_kind: "remove_line", payload: { shopify_variant_id: "44444" } });
  assert.equal(res.ok, true);
  assert.match(res.detail, /no matching line/);
  assert.equal(captured.items, undefined); // nothing written
});

test("non-catalog lingering $0 line still removed by shopify_variant_id (backward compatible)", async () => {
  const captured: { items?: Array<Record<string, unknown>> } = {};
  const admin = makeAdmin(
    {
      subItems: [{ variant_id: "44444", title: "ACV Gummies", quantity: 1 }, { ...COFFEE }],
      snapshotLines: [{ variant_id: "44444", current_price_cents: 0, discounted_total_cents: 0 }],
      variantId: null, // no catalog row — a true non-catalog promo line
    },
    captured,
  );
  const res = await applyMigrationFix(admin, AUDIT, { fix_kind: "remove_line", payload: { shopify_variant_id: "44444" } });
  assert.equal(res.ok, true);
  assert.match(res.detail, /removed 1/);
  assert.deepEqual(captured.items, [{ ...COFFEE }]);
});
