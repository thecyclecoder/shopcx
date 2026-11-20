import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAvalaraLines } from "./avalara-cart";

// Minimal fake of the two Supabase reads buildAvalaraLines makes.
function fakeAdmin(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      const rows = tables[table] || [];
      const q = {
        select: () => q,
        eq: () => q,
        in: (_col: string, ids: string[]) => Promise.resolve({ data: rows.filter((r) => ids.includes(String(r.id))) }),
      };
      return q;
    },
  } as never;
}

const admin = fakeAdmin({
  product_variants: [{ id: "v-tabs", product_id: "p-tabs", shopify_tax_code: null, taxable: true }],
  products: [{ id: "p-tabs", avalara_tax_code: "PF050700", taxable: true, title: "Superfood Tabs" }],
});

test("a line without product_id resolves the product tax code via its variant", async () => {
  const lines = await buildAvalaraLines({
    admin,
    workspaceId: "ws",
    lines: [{ variant_id: "v-tabs", product_id: undefined as unknown as string, title: "Superfood Tabs", quantity: 4, unit_price_cents: 2637, line_total_cents: 10548 }],
    shippingCents: 0,
    protectionCents: 0,
  });
  assert.equal(lines[0].taxCode, "PF050700");
});

test("a line with its own product_id still uses it", async () => {
  const lines = await buildAvalaraLines({
    admin,
    workspaceId: "ws",
    lines: [{ variant_id: "unknown", product_id: "p-tabs", title: "Superfood Tabs", quantity: 1, unit_price_cents: 2637, line_total_cents: 2637 }],
    shippingCents: 0,
    protectionCents: 0,
  });
  assert.equal(lines[0].taxCode, "PF050700");
});
