/**
 * Security regression: reconcileLoyaltyRefundCoupons must reassert the tenant
 * boundary on its service-role `tickets` read. A cross-tenant / mismatched
 * ticketId must NOT become the timestamp authority for the loyalty-refund
 * reconciliation window — it must fail closed (return 0, reconcile nothing).
 *
 *   npx tsx --test src/lib/action-executor.reconcile-tenant-scope.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileLoyaltyRefundCoupons } from "./action-executor";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

// Minimal Supabase-shaped fake supporting the exact chain this fn uses:
//   tickets:            .select().eq().eq().maybeSingle()
//   loyalty_redemptions:.update().eq()×3.ilike().gte().select()
function makeAdmin(tables: Tables) {
  function chain(table: string) {
    const filters: Array<{ col: string; val: unknown; op: string }> = [];
    let pendingUpdate: Row | null = null;
    let selectRequested = false;
    const match = () =>
      (tables[table] ?? []).filter((r) =>
        filters.every((f) => {
          const v = r[f.col];
          if (f.op === "eq") return v === f.val;
          if (f.op === "ilike") return typeof v === "string" && v.startsWith(String(f.val).replace(/%$/, ""));
          if (f.op === "gte") return String(v) >= String(f.val);
          return true;
        }),
      );
    const c = {
      select() { selectRequested = true; return c; },
      eq(col: string, val: unknown) { filters.push({ col, val, op: "eq" }); return c; },
      ilike(col: string, val: unknown) { filters.push({ col, val, op: "ilike" }); return c; },
      gte(col: string, val: unknown) { filters.push({ col, val, op: "gte" }); return c; },
      update(patch: Row) { pendingUpdate = { ...patch }; return c; },
      async maybeSingle() { const rows = match(); return { data: rows[0] ?? null, error: null }; },
      then<T>(onF?: (v: { data: Row[] | null; error: null }) => T) {
        let rows = match();
        if (pendingUpdate) { for (const r of rows) Object.assign(r, pendingUpdate); }
        const data = selectRequested ? rows.map((r) => ({ id: r.id })) : null;
        return Promise.resolve({ data, error: null } as { data: Row[] | null; error: null }).then(onF);
      },
    };
    return c;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => chain(t) } as any;
}

const baseRedemptions = () => [
  { id: "r1", workspace_id: "ws-A", member_id: "m1", status: "active", discount_code: "LOYALTY-15-X", created_at: "2026-07-01T00:00:00Z" },
];

test("cross-tenant ticketId → fails closed (returns 0, reconciles nothing)", async () => {
  const tables: Tables = {
    // ticket belongs to ws-B, but we reconcile for ws-A
    tickets: [{ id: "t-cross", workspace_id: "ws-B", created_at: "2026-06-01T00:00:00Z" }],
    loyalty_redemptions: baseRedemptions(),
  };
  const admin = makeAdmin(tables);
  const n = await reconcileLoyaltyRefundCoupons(admin, "ws-A", "m1", "t-cross");
  assert.equal(n, 0, "a ticket from another workspace must not authorize reconciliation");
  assert.equal(tables.loyalty_redemptions[0].status, "active", "redemption must remain untouched");
});

test("same-tenant ticketId → still reconciles the member's active LOYALTY redemptions", async () => {
  const tables: Tables = {
    tickets: [{ id: "t-ok", workspace_id: "ws-A", created_at: "2026-06-01T00:00:00Z" }],
    loyalty_redemptions: baseRedemptions(),
  };
  const admin = makeAdmin(tables);
  const n = await reconcileLoyaltyRefundCoupons(admin, "ws-A", "m1", "t-ok");
  assert.equal(n, 1, "the in-tenant ticket authorizes reconciliation of the matching redemption");
  assert.equal(tables.loyalty_redemptions[0].status, "redeemed_as_refund");
});
