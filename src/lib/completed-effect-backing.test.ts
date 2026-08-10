/**
 * Unit tests for completed-effect-backing — Phase 1 of
 * docs/brain/specs/claim-guard-backs-completed-effects-on-post-journey-followups.md.
 *
 * Pins the two verification bullets the spec calls out:
 *  (1) A cancellation claim WITH a completed cancel journey on the ticket → the
 *      backed set contains `cancel`, so `unbackedEffectClaim` returns null (the
 *      guard allows the send).
 *  (2) The same claim with NO completed effect → the backed set stays empty, so
 *      `unbackedEffectClaim` still returns "cancel" (the guard blocks + the
 *      caller escalates as before).
 *
 * Plus fail-safe coverage: a DB probe throw returns an EMPTY set (never throws)
 * so the failure mode falls back to today's blocking behavior — blocking a true
 * statement costs an escalation, sending a false one costs a customer's trust.
 *
 * In-memory Supabase stub mirrors the sibling test at sol-cta-reference-guard.test.ts.
 * Run:  npx tsx --test src/lib/completed-effect-backing.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { backedEffectsForCompletedEffects } from "./completed-effect-backing";
import { unbackedEffectClaim } from "./claim-guard";

interface Row {
  [k: string]: unknown;
}

type TableRows = {
  journey_sessions?: Row[];
  subscriptions?: Row[];
};

function makeAdmin(rows: TableRows, opts?: { throwOnTable?: string }) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const b = {
        select(_cols: string) {
          return b;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val);
          return b;
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          if (opts?.throwOnTable === table) throw new Error(`simulated ${table} probe error`);
          const source = (rows[table as keyof TableRows] as Row[] | undefined) ?? [];
          const out = source.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: out, error: null }).then(resolve);
        },
      };
      return b;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const WS = "00000000-0000-0000-0000-0000000000ws";
const TID = "11111111-2222-3333-4444-555555555555";
const CID = "22222222-3333-4444-5555-666666666666";

const CANCELLED_MSG = "Your subscription has been cancelled.";
const CANCEL_JOURNEY_ROW = {
  workspace_id: WS,
  ticket_id: TID,
  status: "completed",
  journey_id: "j-cancel",
  // Simulated PostgREST embed shape — `select("journey_definitions!inner(...)")`
  // returns the embedded row nested under the FK name.
  journey_definitions: { journey_type: "cancellation", workspace_id: WS },
};

// (1) — the exact spec verification: cancel claim + completed cancel journey → passes.
test("completed cancel journey on the ticket backs a cancellation claim (guard allows)", async () => {
  const admin = makeAdmin({ journey_sessions: [CANCEL_JOURNEY_ROW] });
  const backed = await backedEffectsForCompletedEffects({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    customer_id: CID,
  });
  assert.ok(backed.has("cancel"), "cancellation journey → 'cancel' family in backed set");
  assert.equal(
    unbackedEffectClaim(CANCELLED_MSG, backed),
    null,
    "guard must NOT block a truthful restatement of a completed cancel",
  );
});

// (2) — the negative half of the same bullet: same claim, no completed effect → still blocks.
test("same cancellation claim with NO completed effect still blocks + would escalate", async () => {
  const admin = makeAdmin({ journey_sessions: [], subscriptions: [] });
  const backed = await backedEffectsForCompletedEffects({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    customer_id: CID,
  });
  assert.equal(backed.size, 0, "no completed evidence → empty backed set");
  assert.equal(
    unbackedEffectClaim(CANCELLED_MSG, backed),
    "cancel",
    "guard must still block an unbacked cancel claim (caller escalates)",
  );
});

// The 'target entity already in the claimed end state' half of the spec.
test("a subscription already `status='cancelled'` backs a cancellation claim", async () => {
  const admin = makeAdmin({
    subscriptions: [{ workspace_id: WS, customer_id: CID, status: "cancelled" }],
  });
  const backed = await backedEffectsForCompletedEffects({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    customer_id: CID,
  });
  assert.ok(backed.has("cancel"));
  assert.equal(unbackedEffectClaim(CANCELLED_MSG, backed), null);
});

test("a subscription already `status='paused'` backs a pause claim", async () => {
  const admin = makeAdmin({
    subscriptions: [{ workspace_id: WS, customer_id: CID, status: "paused" }],
  });
  const backed = await backedEffectsForCompletedEffects({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    customer_id: CID,
  });
  assert.ok(backed.has("pause"));
  assert.ok(backed.has("crisis_pause"));
  assert.equal(unbackedEffectClaim("I've paused your subscription.", backed), null);
});

// Enumeration-scope narrowing: a foreign-workspace journey cannot back this ticket.
test("a completed journey in ANOTHER workspace cannot back a claim on this ticket", async () => {
  const foreignRow = {
    workspace_id: "00000000-0000-0000-0000-00000000ws2",
    ticket_id: TID,
    status: "completed",
    journey_definitions: { journey_type: "cancellation", workspace_id: WS },
  };
  const admin = makeAdmin({ journey_sessions: [foreignRow] });
  const backed = await backedEffectsForCompletedEffects({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    customer_id: CID,
  });
  assert.equal(backed.size, 0);
  assert.equal(unbackedEffectClaim(CANCELLED_MSG, backed), "cancel");
});

// A journey that is IN-FLIGHT (status != completed) does not back a completion claim.
test("an in-flight journey (status='pending') does NOT back a completion claim", async () => {
  const admin = makeAdmin({
    journey_sessions: [
      {
        workspace_id: WS,
        ticket_id: TID,
        status: "pending",
        journey_definitions: { journey_type: "cancellation", workspace_id: WS },
      },
    ],
  });
  const backed = await backedEffectsForCompletedEffects({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    customer_id: CID,
  });
  assert.equal(backed.size, 0);
});

// Fail-safe: a probe throw returns an EMPTY set — the guard reverts to today's blocking behavior.
test("journey_sessions probe error → empty set (fail-safe: block a true claim over shipping a false one)", async () => {
  const admin = makeAdmin({}, { throwOnTable: "journey_sessions" });
  const backed = await backedEffectsForCompletedEffects({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    customer_id: CID,
  });
  assert.equal(backed.size, 0);
  assert.equal(unbackedEffectClaim(CANCELLED_MSG, backed), "cancel");
});

test("subscriptions probe error → empty set (fail-safe)", async () => {
  const admin = makeAdmin({}, { throwOnTable: "subscriptions" });
  const backed = await backedEffectsForCompletedEffects({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    customer_id: CID,
  });
  assert.equal(backed.size, 0);
});
