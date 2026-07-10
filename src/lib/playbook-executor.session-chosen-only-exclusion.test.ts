/**
 * Phase 4 of
 * docs/brain/specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol.md.
 *
 * The OLD brittle signal matcher (`matchPlaybook` + `matchPlaybookScored` in
 * playbook-executor.ts) used to over-fire on the two assisted-purchase playbooks
 * whenever a customer's message or classified intent matched their broad
 * `trigger_intents` (`buy`, `reorder`, `create_order`, `subscribe`, …). Phase 4
 * makes them SESSION-CHOSEN-ONLY (M4 of sol-session-chosen-playbook-selection-
 * retire-brittle-triggers): they only dispatch when Sol authors
 * `chosen_path='playbook'` + `plan.playbook_slug='assisted-order-purchase' |
 * 'assisted-subscription-purchase'` on the live Direction. The exclusion is
 * enforced at the ACTION POINT (learning #6 — confirming predicate at the write,
 * not a coarser proxy) inside the two matcher functions, via
 * `isSessionChosenOnlyPlaybook(slug)` — a widened `trigger_intents` on the
 * playbook row cannot leak back into the top-score winner.
 *
 * The pure scorer (`scorePlaybookAgainst`) is UNCHANGED — it still scores the
 * assisted-purchase playbooks 1.0 against `buy`/`reorder`/etc. The exclusion is
 * exclusively at the WRAPPER (`matchPlaybookScored` / `matchPlaybook`) that
 * queries the DB. This test file drives those two wrappers with a stubbed admin
 * that mirrors the Phase-2 seed and asserts the exclusion. The pre-existing
 * playbook-executor.assisted-purchase-routing.test.ts still covers the scorer.
 *
 * Run: `npx tsx --test src/lib/playbook-executor.session-chosen-only-exclusion.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { matchPlaybook, matchPlaybookScored } from "./playbook-executor";

// ── stub admin ─────────────────────────────────────────────────────────────

interface StubPlaybookRow {
  id: string;
  name: string;
  slug: string;
  trigger_intents: string[];
  trigger_patterns: string[];
}

/**
 * A minimal Supabase-shaped stub returning the given rows on any
 * `.from('playbooks').select(...).eq(...).eq(...).order(...)` chain. Ignores
 * columns since the wrappers only use the SELECT list (id, name, slug,
 * trigger_intents, trigger_patterns) fields. Any workspace_id / is_active
 * filter is accepted as a chainable no-op — the test only cares which rows
 * are surfaced.
 */
function stubAdmin(rows: StubPlaybookRow[]): unknown {
  const chain = {
    select(_cols: string) {
      return this;
    },
    eq(_col: string, _val: unknown) {
      return this;
    },
    order(_col: string, _opts: unknown) {
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return { from(_table: string) { return chain; } };
}

// The exact rows the Phase-2 seed migration inserts (per the pinned trigger set
// in playbook-executor.assisted-purchase-routing.test.ts) plus a control playbook
// that should still match — "refund" — so the exclusion is provably narrow.
const ASSISTED_ORDER: StubPlaybookRow = {
  id: "pb-assisted-order",
  name: "Assisted Order Purchase",
  slug: "assisted-order-purchase",
  trigger_intents: ["create_order", "assisted_purchase_order", "buy", "reorder"],
  trigger_patterns: [],
};

const ASSISTED_SUB: StubPlaybookRow = {
  id: "pb-assisted-sub",
  name: "Assisted Subscription Purchase",
  slug: "assisted-subscription-purchase",
  trigger_intents: ["create_subscription", "assisted_purchase_subscription", "add_subscription", "subscribe"],
  trigger_patterns: [],
};

const REFUND: StubPlaybookRow = {
  id: "pb-refund",
  name: "Refund",
  slug: "refund",
  trigger_intents: ["refund", "money_back", "want refund"],
  trigger_patterns: [],
};

// ── matchPlaybookScored — the scored wrapper ─────────────────────────────

test("matchPlaybookScored: 'buy' intent + assisted-order-purchase row → returns NULL (session-chosen-only exclusion)", async () => {
  const admin = stubAdmin([ASSISTED_ORDER]);
  const r = await matchPlaybookScored(admin as never, "ws-1", "buy", "I want to buy another jar");
  assert.equal(r, null, "assisted-order-purchase must not surface via the signal matcher");
});

test("matchPlaybookScored: 'subscribe' intent + assisted-subscription-purchase row → returns NULL (session-chosen-only)", async () => {
  const admin = stubAdmin([ASSISTED_SUB]);
  const r = await matchPlaybookScored(admin as never, "ws-1", "subscribe", "sign me up");
  assert.equal(r, null, "assisted-subscription-purchase must not surface via the signal matcher");
});

test("matchPlaybookScored: 'reorder' intent + BOTH assisted-purchase rows → returns NULL (both excluded)", async () => {
  const admin = stubAdmin([ASSISTED_ORDER, ASSISTED_SUB]);
  const r = await matchPlaybookScored(admin as never, "ws-1", "reorder", "reorder my last one");
  assert.equal(r, null, "both assisted-purchase playbooks must be filtered before scoring");
});

test("matchPlaybookScored: 'refund' + refund + assisted-order rows → returns the REFUND playbook (exclusion is narrow)", async () => {
  const admin = stubAdmin([ASSISTED_ORDER, REFUND]);
  const r = await matchPlaybookScored(admin as never, "ws-1", "refund", "please refund");
  assert.ok(r, "a non-assisted playbook must still match");
  assert.equal(r?.name, "Refund");
});

// ── matchPlaybook — the boolean wrapper ─────────────────────────────────

test("matchPlaybook: 'buy' intent + assisted-order-purchase row → returns NULL (exclusion)", async () => {
  const admin = stubAdmin([ASSISTED_ORDER]);
  const r = await matchPlaybook(admin as never, "ws-1", "buy", "I want to buy another jar");
  assert.equal(r, null, "assisted-order-purchase must not surface via the boolean signal matcher");
});

test("matchPlaybook: 'subscribe' intent + assisted-subscription-purchase row → returns NULL", async () => {
  const admin = stubAdmin([ASSISTED_SUB]);
  const r = await matchPlaybook(admin as never, "ws-1", "subscribe", "sign me up");
  assert.equal(r, null);
});

test("matchPlaybook: 'refund' intent + refund + assisted-order rows → returns the REFUND playbook (exclusion is narrow)", async () => {
  const admin = stubAdmin([ASSISTED_ORDER, REFUND]);
  const r = await matchPlaybook(admin as never, "ws-1", "refund", "please refund");
  assert.ok(r, "a non-assisted playbook must still match");
  assert.equal(r?.name, "Refund");
});
