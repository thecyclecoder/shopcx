/**
 * Unit tests for the vaulted-PM guard the assisted-purchase-playbook spec
 * pins on create_order + create_subscription (Phase 1, deterministic
 * safety net). Two failing states the verification names:
 *
 *   (1) create_order / create_subscription for a customer with NO vaulted
 *       PM must NOT call the commerce effector — the executor returns a
 *       "no_vaulted_payment_method" deferral instead.
 *   (2) A customer WITH a chargeable vaulted PM proceeds past the guard
 *       (the unconditional guard is not a silent block on the happy path).
 *
 * Pure — no live DB. Uses an in-memory fake admin whose chain surface
 * covers the guard's queries (customer_links, customer_payment_methods,
 * journey_definitions) plus the deferral's internal-note insert.
 *
 * Run: `npx tsx --test src/lib/action-executor.vaulted-pm-guard.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  pickChargeableVaultedPm,
  directActionHandlers,
  type ActionContext,
  type ActionParams,
  type CustomerPaymentMethodRow,
} from "./action-executor";

// ── Pure predicate — pins the exact chargeable-row semantics ──────────

test("pickChargeableVaultedPm — empty / null / undefined rows → null (fail-closed)", () => {
  assert.equal(pickChargeableVaultedPm(null), null);
  assert.equal(pickChargeableVaultedPm(undefined), null);
  assert.equal(pickChargeableVaultedPm([]), null);
});

test("pickChargeableVaultedPm — only non-active rows (revoked/removed) → null (never charge a dead vault)", () => {
  const pm = pickChargeableVaultedPm([
    { id: "pm-1", status: "revoked", is_default: true },
    { id: "pm-2", status: "removed", is_default: false },
  ]);
  assert.equal(pm, null);
});

test("pickChargeableVaultedPm — prefers is_default=true among active rows", () => {
  const pm = pickChargeableVaultedPm([
    { id: "pm-1", status: "active", is_default: false },
    { id: "pm-2", status: "active", is_default: true },
    { id: "pm-3", status: "active", is_default: false },
  ]);
  assert.equal(pm?.id, "pm-2");
});

test("pickChargeableVaultedPm — no default → returns first active row (still chargeable)", () => {
  const pm = pickChargeableVaultedPm([
    { id: "pm-1", status: "active", is_default: false },
    { id: "pm-2", status: "active", is_default: null },
  ]);
  assert.equal(pm?.id, "pm-1");
});

// ── Fake admin covering the guard's Supabase chain surface ─────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Chain {
  select: (..._args: unknown[]) => Chain;
  eq: (col: string, val: unknown) => Chain;
  in: (col: string, vals: unknown[]) => Chain;
  limit: (n: number) => Chain;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  single: () => Promise<{ data: Row | null; error: null }>;
  then: <T>(cb: (r: { data: Row[]; error: null }) => T) => Promise<T>;
}

interface InsertLog {
  table: string;
  row: Row;
}

function makeChain(tables: Tables, table: string, inserts: InsertLog[]): Chain & {
  insert: (row: Row) => Promise<{ error: null }>;
} {
  const eqFilters: Array<[string, unknown]> = [];
  const inFilters: Array<[string, unknown[]]> = [];
  let limitN: number | null = null;

  const resolve = (): { data: Row[]; error: null } => {
    const all = tables[table] ?? [];
    let rows = all.filter((r) => {
      for (const [c, v] of eqFilters) if (r[c] !== v) return false;
      for (const [c, vs] of inFilters) if (!vs.includes(r[c] as unknown)) return false;
      return true;
    });
    if (limitN != null) rows = rows.slice(0, limitN);
    return { data: rows, error: null };
  };

  const chain: Chain & { insert: (row: Row) => Promise<{ error: null }> } = {
    select: () => chain,
    eq: (col, val) => { eqFilters.push([col, val]); return chain; },
    in: (col, vals) => { inFilters.push([col, vals]); return chain; },
    limit: (n) => { limitN = n; return chain; },
    maybeSingle: async () => {
      const r = resolve();
      return { data: r.data[0] ?? null, error: null };
    },
    single: async () => {
      const r = resolve();
      return { data: r.data[0] ?? null, error: null };
    },
    then: (cb) => Promise.resolve(cb(resolve())),
    insert: async (row) => { inserts.push({ table, row }); return { error: null }; },
  };
  return chain;
}

function makeAdmin(tables: Tables, inserts: InsertLog[]): ActionContext["admin"] {
  return {
    from(table: string) {
      return makeChain(tables, table, inserts);
    },
  } as unknown as ActionContext["admin"];
}

function makeCtx(
  tables: Tables,
  inserts: InsertLog[] = [],
  overrides: Partial<ActionContext> = {},
): ActionContext {
  return {
    admin: makeAdmin(tables, inserts),
    workspaceId: "ws-1",
    ticketId: "t-1",
    customerId: "c-1",
    channel: "chat",
    sandbox: true,
    ...overrides,
  };
}

// ── Handler-level tests — the exact failing states the spec pins ───────

test("(FAILING STATE) create_order — customer with NO vaulted PM: deferred, effector NEVER reached", async () => {
  // No customer_payment_methods rows at all. The guard's fail-closed
  // branch must fire — the shape of the returned ActionResult proves
  // control never reached the createOrder effector below.
  const inserts: InsertLog[] = [];
  const ctx = makeCtx({
    customer_links: [],
    customer_payment_methods: [],
    journey_definitions: [],   // no active definition → launch is skipped
  }, inserts);

  const action: ActionParams = {
    type: "create_order",
    vendor: "internal",
    line_items: [{ variant_id: "v-1", title: "T", quantity: 1, unit_cents: 1000 }],
  };

  const result = await directActionHandlers.create_order(ctx, action);
  assert.equal(result.success, false);
  assert.equal(result.error, "no_vaulted_payment_method");
  assert.match(result.summary || "", /deferred/);
  // Internal note recording the deferral was written on the ticket.
  const notes = inserts.filter((i) => i.table === "ticket_messages");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].row.ticket_id, "t-1");
  assert.match(String(notes[0].row.body), /create_order deferred — no vaulted payment method/);
});

test("(FAILING STATE) create_subscription — customer with NO vaulted PM: deferred, effector NEVER reached", async () => {
  const inserts: InsertLog[] = [];
  const ctx = makeCtx({
    customer_links: [],
    customer_payment_methods: [],
    journey_definitions: [],
  }, inserts);

  const action: ActionParams = {
    type: "create_subscription",
    vendor: "internal",
    items: [{ variant_id: "v-1", quantity: 1 }],
    interval: "MONTH",
    interval_count: 1,
    next_billing_date: "2026-08-15",
  };

  const result = await directActionHandlers.create_subscription(ctx, action);
  assert.equal(result.success, false);
  assert.equal(result.error, "no_vaulted_payment_method");
  assert.match(result.summary || "", /deferred/);
  const notes = inserts.filter((i) => i.table === "ticket_messages");
  assert.equal(notes.length, 1);
  assert.match(String(notes[0].row.body), /create_subscription deferred — no vaulted payment method/);
});

test("(FAILING STATE) create_order — only revoked/removed rows on file → still deferred (guard reads status, not row existence)", async () => {
  // The bug this test pins: a naive "any row?" check would let a customer
  // with only revoked vaults reach the effector. The guard reads
  // status='active' — nothing else.
  const inserts: InsertLog[] = [];
  const rows: CustomerPaymentMethodRow[] = [
    { id: "pm-1", status: "revoked", is_default: true },
    { id: "pm-2", status: "removed", is_default: false },
  ];
  const ctx = makeCtx({
    customer_links: [],
    customer_payment_methods: rows.map((r) => ({
      ...r, workspace_id: "ws-1", customer_id: "c-1",
    })) as unknown as Row[],
    journey_definitions: [],
  }, inserts);

  const action: ActionParams = {
    type: "create_order",
    vendor: "internal",
    line_items: [{ variant_id: "v-1", title: "T", quantity: 1, unit_cents: 1000 }],
  };
  const result = await directActionHandlers.create_order(ctx, action);
  assert.equal(result.success, false);
  assert.equal(result.error, "no_vaulted_payment_method");
});

test("(HAPPY PATH — guard passes) create_order — customer WITH an active vaulted PM proceeds past the guard", async () => {
  // The invariant: the guard is unconditional but NOT a silent block. When
  // a chargeable vaulted PM is on file, the guard passes and control
  // reaches the vendor-validation block below it. We prove this by
  // omitting `vendor` in the params — if the guard fired we'd see
  // "no_vaulted_payment_method"; instead we see "create_order missing
  // vendor" from the block that runs AFTER the guard. That is the exact
  // signal the effector path was reached.
  const inserts: InsertLog[] = [];
  const ctx = makeCtx({
    customer_links: [],
    customer_payment_methods: [
      { id: "pm-1", workspace_id: "ws-1", customer_id: "c-1", status: "active", is_default: true },
    ],
    journey_definitions: [],
  }, inserts);

  const action: ActionParams = { type: "create_order" }; // no vendor
  const result = await directActionHandlers.create_order(ctx, action);
  assert.equal(result.success, false);
  assert.equal(result.error, "create_order missing vendor");
});

test("(HAPPY PATH — guard passes) create_subscription — customer WITH an active vaulted PM proceeds past the guard", async () => {
  const inserts: InsertLog[] = [];
  const ctx = makeCtx({
    customer_links: [],
    customer_payment_methods: [
      { id: "pm-1", workspace_id: "ws-1", customer_id: "c-1", status: "active", is_default: true },
    ],
    journey_definitions: [],
  }, inserts);

  const action: ActionParams = { type: "create_subscription" };
  const result = await directActionHandlers.create_subscription(ctx, action);
  assert.equal(result.success, false);
  assert.equal(result.error, "create_subscription missing vendor");
});

test("(LINKED ACCOUNT) create_order — vaulted PM lives on a linked customer id: guard passes", async () => {
  // A customer is linked (via customer_links.group_id) to a sibling that
  // holds the vaulted PM. The guard expands linked ids and honors the
  // vault so the linked household isn't asked to add a card they already
  // have on the primary account.
  const inserts: InsertLog[] = [];
  const ctx = makeCtx({
    customer_links: [
      { customer_id: "c-1", group_id: "g-1" },
      { customer_id: "c-2", group_id: "g-1" },
    ],
    customer_payment_methods: [
      { id: "pm-1", workspace_id: "ws-1", customer_id: "c-2", status: "active", is_default: true },
    ],
    journey_definitions: [],
  }, inserts);

  const action: ActionParams = { type: "create_order" };
  const result = await directActionHandlers.create_order(ctx, action);
  // Guard passes → vendor-validation runs → missing-vendor is the signal.
  assert.equal(result.error, "create_order missing vendor");
});
