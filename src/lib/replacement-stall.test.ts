/**
 * Regression pins for [[replacement-stall]] — Phase 3 of the
 * replacement-order-robustness spec. Grounded in Evan H.'s SC132221
 * Jun-23 record (`d73f3103…`) that sat at `address_confirmed` for 17
 * days until SC134462 + SC134463 fulfilled the same two owed tabs.
 *
 * The pins cover:
 *   • [[isReplacementStalled]] — positive (SC132221 shape) + negatives
 *     (healthy in-flight, terminal, missing replacement_order_id but
 *     recent, wrong status)
 *   • [[isSupersededBy]] — SC132221's exact union-cover shape
 *     (2 later single-item orders cover a 2-item stall) + negatives
 *     (later hasn't shipped, later covers wrong items, later is older)
 *   • [[applySupersede]] — the compare-and-set guard: a raced /
 *     already-terminal row cannot be overwritten (coaching #9/#10)
 *
 * Run: npx tsx --test src/lib/replacement-stall.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isReplacementStalled,
  isSupersededBy,
  applySupersede,
  type ReplacementRow,
} from "./replacement-stall";

const NOW = new Date("2026-07-10T00:00:00Z");

function row(overrides: Partial<ReplacementRow>): ReplacementRow {
  return {
    id: "r-x",
    workspace_id: "ws-1",
    status: "pending",
    original_order_id: "ord-1",
    replacement_order_id: null,
    shopify_replacement_order_name: null,
    items: [],
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

// ── isReplacementStalled ──

test("[SC132221] address_confirmed + null replacement_order_id + null shopify_replacement_order_name + 17 days old → STALLED", () => {
  const evanJun23 = row({
    id: "d73f3103-1111-2222-3333-444444444444",
    status: "address_confirmed",
    replacement_order_id: null,
    shopify_replacement_order_name: null,
    items: [
      { variantId: "pm-vid", quantity: 1, title: "Peach Mango" },
      { variantId: "sl-vid", quantity: 1, title: "Strawberry Lemonade" },
    ],
    created_at: "2026-06-23T00:00:00Z", // 17 days before NOW
  });
  assert.equal(isReplacementStalled(evanJun23, NOW), true);
});

test("healthy in-flight — address_confirmed but only 2 hours old — NOT stalled (well under 7d threshold)", () => {
  const recent = row({
    status: "address_confirmed",
    created_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(isReplacementStalled(recent, NOW), false);
});

test("terminal-success row (created + Shopify name) — NOT stalled even if old (already shipped)", () => {
  const shipped = row({
    status: "created",
    shopify_replacement_order_name: "SC134462",
    created_at: "2026-01-01T00:00:00Z",
  });
  assert.equal(isReplacementStalled(shipped, NOW), false);
});

test("failed row — NOT stalled (has terminal status; the loud-fail Phase 1 path already surfaces it)", () => {
  const failed = row({
    status: "failed",
    created_at: "2026-06-01T00:00:00Z",
  });
  assert.equal(isReplacementStalled(failed, NOW), false);
});

test("address_confirmed but replacement_order_id is set — NOT stalled (the Shopify order landed)", () => {
  const linked = row({
    status: "address_confirmed",
    replacement_order_id: "ord-99",
    created_at: "2026-06-01T00:00:00Z",
  });
  assert.equal(isReplacementStalled(linked, NOW), false);
});

test("address_confirmed but shopify_replacement_order_name is set — NOT stalled (name pinned; order flowed)", () => {
  const named = row({
    status: "address_confirmed",
    shopify_replacement_order_name: "SC999",
    created_at: "2026-06-01T00:00:00Z",
  });
  assert.equal(isReplacementStalled(named, NOW), false);
});

test("custom threshold — a 10-day-old row is stalled at threshold=7 but not at threshold=14", () => {
  const tenDays = row({
    status: "address_confirmed",
    created_at: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(isReplacementStalled(tenDays, NOW, 7), true);
  assert.equal(isReplacementStalled(tenDays, NOW, 14), false);
});

// ── isSupersededBy ──

test("[SC132221] Jun-23 2-item stall + two later single-item shipped orders together cover both variants → SUPERSEDED", () => {
  const stalled = row({
    id: "d73f3103-1111-2222-3333-444444444444",
    status: "address_confirmed",
    items: [
      { variantId: "pm-vid", quantity: 1 },
      { variantId: "sl-vid", quantity: 1 },
    ],
    created_at: "2026-06-23T00:00:00Z",
  });
  const sc134462 = row({
    id: "sc134462-uuid",
    status: "created",
    shopify_replacement_order_name: "SC134462",
    items: [{ variantId: "pm-vid", quantity: 1 }],
    created_at: "2026-07-10T10:00:00Z",
  });
  const sc134463 = row({
    id: "sc134463-uuid",
    status: "shipped",
    shopify_replacement_order_name: "SC134463",
    items: [{ variantId: "sl-vid", quantity: 1 }],
    created_at: "2026-07-10T10:05:00Z",
  });
  assert.equal(isSupersededBy(stalled, [sc134462, sc134463]), true);
});

test("later replacement hasn't shipped yet (status='pending') → NOT superseded (customer got nothing)", () => {
  const stalled = row({ status: "address_confirmed", items: [{ variantId: "pm-vid" }], created_at: "2026-06-23T00:00:00Z" });
  const pending = row({ id: "s2", status: "pending", items: [{ variantId: "pm-vid" }], created_at: "2026-07-01T00:00:00Z" });
  assert.equal(isSupersededBy(stalled, [pending]), false);
});

test("later replacement covers a DIFFERENT variant — NOT superseded (the stalled obligation still owed)", () => {
  const stalled = row({ status: "address_confirmed", items: [{ variantId: "pm-vid" }, { variantId: "sl-vid" }], created_at: "2026-06-23T00:00:00Z" });
  const wrongItem = row({ id: "s2", status: "shipped", shopify_replacement_order_name: "SCX", items: [{ variantId: "wrong-vid" }], created_at: "2026-07-01T00:00:00Z" });
  assert.equal(isSupersededBy(stalled, [wrongItem]), false);
});

test("later replacement is on a DIFFERENT original_order_id — NOT superseded (unrelated order's shipment)", () => {
  const stalled = row({ status: "address_confirmed", original_order_id: "ord-1", items: [{ variantId: "pm-vid" }], created_at: "2026-06-23T00:00:00Z" });
  const otherOrder = row({ id: "s2", status: "shipped", shopify_replacement_order_name: "SCX", original_order_id: "ord-2", items: [{ variantId: "pm-vid" }], created_at: "2026-07-01T00:00:00Z" });
  assert.equal(isSupersededBy(stalled, [otherOrder]), false);
});

test("later replacement is on a DIFFERENT workspace — NOT superseded (cross-workspace bleed guard)", () => {
  const stalled = row({ workspace_id: "ws-1", status: "address_confirmed", items: [{ variantId: "pm-vid" }], created_at: "2026-06-23T00:00:00Z" });
  const otherWs = row({ id: "s2", workspace_id: "ws-2", status: "shipped", shopify_replacement_order_name: "SCX", items: [{ variantId: "pm-vid" }], created_at: "2026-07-01T00:00:00Z" });
  assert.equal(isSupersededBy(stalled, [otherWs]), false);
});

test("candidate is OLDER than the stalled row → NOT superseded (later means later)", () => {
  const stalled = row({ status: "address_confirmed", items: [{ variantId: "pm-vid" }], created_at: "2026-07-01T00:00:00Z" });
  const older = row({ id: "s2", status: "shipped", shopify_replacement_order_name: "SCX", items: [{ variantId: "pm-vid" }], created_at: "2026-06-01T00:00:00Z" });
  assert.equal(isSupersededBy(stalled, [older]), false);
});

test("stalled row has no items → NOT superseded (nothing concrete to reconcile)", () => {
  const stalled = row({ status: "address_confirmed", items: [], created_at: "2026-06-23T00:00:00Z" });
  const later = row({ id: "s2", status: "shipped", shopify_replacement_order_name: "SCX", items: [{ variantId: "pm-vid" }], created_at: "2026-07-01T00:00:00Z" });
  assert.equal(isSupersededBy(stalled, [later]), false);
});

// ── applySupersede — the compare-and-set guard (coaching #9/#10) ──

type UpdateCall = { field: string; value: unknown };

function fakeAdmin(rowsInDb: Array<Pick<ReplacementRow, "id" | "workspace_id" | "status">>) {
  const updates: Array<{ patch: Record<string, unknown>; filters: UpdateCall[] }> = [];
  const admin = {
    from: (table: string) => {
      assert.equal(table, "replacements");
      let patch: Record<string, unknown> = {};
      const filters: UpdateCall[] = [];
      const chain = {
        update: (p: Record<string, unknown>) => { patch = p; return chain; },
        eq: (field: string, value: unknown) => { filters.push({ field, value }); return chain; },
        select: (_cols: string) => {
          const matched = rowsInDb.filter(r => filters.every(f => (r as unknown as Record<string, unknown>)[f.field] === f.value));
          if (matched.length === 1) {
            updates.push({ patch, filters });
          }
          return Promise.resolve({ data: matched.map(m => ({ id: m.id })), error: null });
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof applySupersede>[0];
  return { admin, updates };
}

test("[coaching #9] applySupersede compare-and-set — a raced row already in status='failed' is NOT overwritten (0 rows matched)", async () => {
  const { admin, updates } = fakeAdmin([
    { id: "r-1", workspace_id: "ws-1", status: "failed" }, // upstream already marked it failed
  ]);
  const ok = await applySupersede(admin, { workspaceId: "ws-1", replacementId: "r-1", supersededByReplacementId: "r-2" });
  assert.equal(ok, false, "guard must reject — status changed since read");
  assert.equal(updates.length, 0, "no write must have fired");
});

test("[coaching #10] applySupersede compare-and-set — cross-workspace id collision cannot overwrite (workspace filter narrows)", async () => {
  const { admin, updates } = fakeAdmin([
    { id: "r-1", workspace_id: "ws-2", status: "address_confirmed" }, // right id, wrong workspace
  ]);
  const ok = await applySupersede(admin, { workspaceId: "ws-1", replacementId: "r-1", supersededByReplacementId: null });
  assert.equal(ok, false);
  assert.equal(updates.length, 0);
});

test("applySupersede — happy path: address_confirmed row in right workspace flips to superseded (exactly one row transitions)", async () => {
  const { admin, updates } = fakeAdmin([
    { id: "r-1", workspace_id: "ws-1", status: "address_confirmed" },
  ]);
  const ok = await applySupersede(admin, { workspaceId: "ws-1", replacementId: "r-1", supersededByReplacementId: "r-2" });
  assert.equal(ok, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.status, "superseded");
  assert.match(String(updates[0].patch.reason_detail || ""), /Superseded by replacement r-2/);
  // Prove the guard filters were applied (workspace + id + status='address_confirmed').
  const fields = updates[0].filters.map(f => f.field);
  assert.ok(fields.includes("workspace_id"));
  assert.ok(fields.includes("id"));
  assert.ok(fields.includes("status"));
});
