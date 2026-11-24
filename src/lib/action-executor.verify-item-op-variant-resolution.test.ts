/**
 * Regression tests for verifyActionInDB item-op cases resolving variant ids
 * across engines before comparing.
 *
 * Named failing state (spec verify-item-op-resolves-variant-id-across-engines,
 * ticket f6c18f31 — Sara Kasemeier): on an INTERNAL-engine subscription the
 * stored subscriptions.items[].variant_id is our catalog UUID (e.g.
 * dc100894-… Peach Mango), but the orchestrator's action carries the Shopify
 * NUMERIC variant id (e.g. 42614433513645). A raw String===String compare
 * never matched, so a swap/add/remove/qty op that ACTUALLY LANDED verified
 * FALSE, the self-heal loop retried a now-absent old variant, and the resolved
 * ticket false-escalated. verifyActionInDB must canonicalize both sides (map a
 * Shopify numeric id → the catalog UUID via product_variants.shopify_variant_id)
 * so the landed op verifies TRUE.
 *
 * Pure — no live DB. Uses the same in-memory fake admin shape as
 * action-executor.verify-in-db.test.ts, extended with a product_variants table
 * so the canonicalization read resolves. Run:
 *   npx tsx --test src/lib/action-executor.verify-item-op-variant-resolution.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { verifyActionInDB, type ActionParams } from "./action-executor";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Filter {
  kind: "eq" | "in";
  col: string;
  val: unknown;
}

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.kind === "in") {
      const set = f.val as unknown[];
      if (!Array.isArray(set) || !set.includes(row[f.col])) return false;
      continue;
    }
    if (row[f.col] !== f.val) return false;
  }
  return true;
}

interface FakeChain {
  select: (...args: unknown[]) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  in: (col: string, vals: unknown[]) => FakeChain;
  order: (col: string, opts?: { ascending?: boolean }) => FakeChain;
  limit: (n: number) => FakeChain;
  single: () => Promise<{ data: Row | null; error: null }>;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  let limitN: number | null = null;
  const resolve = () => {
    const all = tables[table] ?? [];
    let rows = all.filter((r) => matches(r, filters));
    if (limitN != null) rows = rows.slice(0, limitN);
    return { data: rows, error: null as null };
  };
  const chain: FakeChain = {
    select: () => chain,
    eq: (col, val) => {
      filters.push({ kind: "eq", col, val });
      return chain;
    },
    in: (col, vals) => {
      filters.push({ kind: "in", col, val: vals });
      return chain;
    },
    order: () => chain,
    limit: (n) => {
      limitN = n;
      return chain;
    },
    single: async () => {
      const r = resolve();
      return { data: r.data[0] ?? null, error: null };
    },
    maybeSingle: async () => {
      const r = resolve();
      return { data: r.data[0] ?? null, error: null };
    },
  };
  return chain;
}

function makeAdmin(tables: Tables) {
  return {
    from(table: string) {
      return makeChain(tables, table);
    },
  } as unknown as Parameters<typeof verifyActionInDB>[0]["admin"];
}

// Ground-truth-shaped ids: a catalog UUID on the subscription line + the
// Shopify numeric variant id the orchestrator's action carries.
const PEACH_UUID = "dc100894-76c9-4ad0-9e02-6012f35f5e1a";
const PEACH_SHOPIFY = "42614433513645";
const OLD_UUID = "6ab0ddac-1111-2222-3333-444455556666";

function groundTruthTables(lineVariantId: string): Tables {
  return {
    subscriptions: [
      {
        id: "sub-9abe2bc2",
        shopify_contract_id: "internal-b5c2cee7436841a3",
        workspace_id: "w1",
        customer_id: "c-sara",
        items: [{ variant_id: lineVariantId, quantity: 1, price_cents: 3200 }],
      },
    ],
    product_variants: [
      { id: PEACH_UUID, shopify_variant_id: PEACH_SHOPIFY, workspace_id: "w1" },
    ],
  };
}

function scopedCtx(tables: Tables) {
  return {
    admin: makeAdmin(tables),
    ticketId: "ticket-f6c18f31",
    workspaceId: "w1",
    customerId: "c-sara",
  };
}

test("swap_variant — line stores UUID, action carries Shopify numeric new_variant_id → verified TRUE (the f6c18f31 fix)", async () => {
  // Pre-fix this returned FALSE: String(dc100894-…) !== String(42614433513645).
  const ctx = scopedCtx(groundTruthTables(PEACH_UUID));
  const action: ActionParams = {
    type: "swap_variant",
    contract_id: "internal-b5c2cee7436841a3",
    old_variant_id: OLD_UUID,
    new_variant_id: PEACH_SHOPIFY,
  };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("swap_variant — swap did NOT land (line still shows the old UUID) → verified FALSE", async () => {
  // Negative control: the canonicalized new variant is genuinely absent, so
  // the self-heal gate correctly reports the op did not stick.
  const ctx = scopedCtx(groundTruthTables(OLD_UUID));
  const action: ActionParams = {
    type: "swap_variant",
    contract_id: "internal-b5c2cee7436841a3",
    old_variant_id: OLD_UUID,
    new_variant_id: PEACH_SHOPIFY,
  };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("add_item — line stores UUID, action carries Shopify numeric variant_id → verified TRUE", async () => {
  const ctx = scopedCtx(groundTruthTables(PEACH_UUID));
  const action: ActionParams = {
    type: "add_item",
    contract_id: "internal-b5c2cee7436841a3",
    variant_id: PEACH_SHOPIFY,
    quantity: 1,
  };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("remove_item — action carries Shopify numeric id, line (UUID) is gone → verified TRUE", async () => {
  // Line carries a DIFFERENT variant; the removed one (resolved to PEACH_UUID)
  // is absent, so removal verifies true.
  const tables = groundTruthTables(OLD_UUID);
  const ctx = scopedCtx(tables);
  const action: ActionParams = {
    type: "remove_item",
    contract_id: "internal-b5c2cee7436841a3",
    variant_id: PEACH_SHOPIFY,
  };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("remove_item — action carries Shopify numeric id but the resolved UUID line is STILL present → verified FALSE", async () => {
  const ctx = scopedCtx(groundTruthTables(PEACH_UUID));
  const action: ActionParams = {
    type: "remove_item",
    contract_id: "internal-b5c2cee7436841a3",
    variant_id: PEACH_SHOPIFY,
  };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("change_quantity — action carries Shopify numeric id; quantity on the resolved UUID line matches → verified TRUE", async () => {
  const tables: Tables = {
    subscriptions: [
      {
        id: "sub-9abe2bc2",
        shopify_contract_id: "internal-b5c2cee7436841a3",
        workspace_id: "w1",
        customer_id: "c-sara",
        items: [{ variant_id: PEACH_UUID, quantity: 3, price_cents: 3200 }],
      },
    ],
    product_variants: [
      { id: PEACH_UUID, shopify_variant_id: PEACH_SHOPIFY, workspace_id: "w1" },
    ],
  };
  const ctx = scopedCtx(tables);
  const action: ActionParams = {
    type: "change_quantity",
    contract_id: "internal-b5c2cee7436841a3",
    variant_id: PEACH_SHOPIFY,
    quantity: 3,
  };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("update_line_item_price — action carries Shopify numeric id; price on the resolved UUID line matches → verified TRUE", async () => {
  const tables: Tables = {
    subscriptions: [
      {
        id: "sub-9abe2bc2",
        shopify_contract_id: "internal-b5c2cee7436841a3",
        workspace_id: "w1",
        customer_id: "c-sara",
        items: [{ variant_id: PEACH_UUID, quantity: 1, price_cents: 2500 }],
      },
    ],
    product_variants: [
      { id: PEACH_UUID, shopify_variant_id: PEACH_SHOPIFY, workspace_id: "w1" },
    ],
  };
  const ctx = scopedCtx(tables);
  const action: ActionParams = {
    type: "update_line_item_price",
    contract_id: "internal-b5c2cee7436841a3",
    variant_id: PEACH_SHOPIFY,
    base_price_cents: 2500,
  };
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("fallback — no workspaceId in ctx: raw-string compare preserved (UUID line vs numeric action → FALSE, no regression)", async () => {
  // Callers that pass only { admin, ticketId } cannot resolve; behavior is the
  // pre-fix raw compare. A matching raw id still verifies (next test).
  const ctx = {
    admin: makeAdmin(groundTruthTables(PEACH_UUID)),
    ticketId: "ticket-f6c18f31",
  };
  const action: ActionParams = {
    type: "swap_variant",
    contract_id: "internal-b5c2cee7436841a3",
    new_variant_id: PEACH_SHOPIFY,
  };
  assert.equal(await verifyActionInDB(ctx, action), false);
});

test("fallback — no workspaceId: raw UUID on both sides still verifies TRUE (idempotent, no resolution needed)", async () => {
  const ctx = {
    admin: makeAdmin(groundTruthTables(PEACH_UUID)),
    ticketId: "ticket-f6c18f31",
  };
  const action: ActionParams = {
    type: "swap_variant",
    contract_id: "internal-b5c2cee7436841a3",
    new_variant_id: PEACH_UUID,
  };
  assert.equal(await verifyActionInDB(ctx, action), true);
});
