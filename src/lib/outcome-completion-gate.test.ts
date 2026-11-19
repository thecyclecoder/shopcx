/**
 * Unit tests for the Phase-4 completion gate
 * (docs/brain/specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified.md § Phase 4).
 *
 * Focus: the failing state from ticket 0a9e4d7f (Judy) — a ticket with unverified
 * required_outcome items must NOT auto-resolve. The Phase-4 invariant:
 *   1. `assessOutcomeCompletion` returns `ok=true` iff every row's status is 'verified'.
 *   2. `ok=false` names EVERY unfinished item (pending / done / failed) verbatim so the
 *      escalation reason surfaces them.
 *   3. `verified` is the only closed status — a `done` row (executor fired, DB verify hasn't
 *      confirmed) leaves the ticket in-progress, same as `pending`.
 *   4. A ticket with NO required outcomes passes freely (backward-compatible with the
 *      pre-required_outcomes world — a naked reply-only turn still auto-closes).
 *
 * Run: npx tsx --test src/lib/outcome-completion-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { TicketRequiredOutcome, RequiredOutcomeStatus } from "./ticket-required-outcomes";
import { assessOutcomeCompletion, buildEscalationReason, waivePolicyForbiddenOutcomes } from "./outcome-completion-gate";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assessPolicyForbidden } from "./required-outcome-policy";

function fakeOutcome(overrides: Partial<TicketRequiredOutcome> & { status: RequiredOutcomeStatus }): TicketRequiredOutcome {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    workspace_id: "w",
    ticket_id: "t",
    direction_id: null,
    kind: "noop",
    description: "noop",
    target_ids: {},
    expected_db_state: {},
    resolution_event_id: null,
    verified_at: null,
    failed_reason: null,
    authored_by: "test",
    authored_at: new Date(0).toISOString(),
    ...overrides,
  };
}

// ── The named failing state (Judy, learning #8) ─────────────────────────

test("Judy failing state: ticket has pending bag + failed credit → BLOCKED, both items named on escalation reason", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add a second bag to next order", status: "pending" }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "apply $15 credit", status: "failed", failed_reason: "coupon executor refused" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false);
  const unfinished = (verdict as { unfinished_items: Array<{ description: string; status: string }> }).unfinished_items;
  const descs = unfinished.map((u) => u.description).sort();
  assert.deepEqual(descs, ["add a second bag to next order", "apply $15 credit"]);
  const statuses = unfinished.map((u) => u.status).sort();
  assert.deepEqual(statuses, ["failed", "pending"]);
  // Escalation reason must NAME both items (Phase 4 verification bullet 3).
  const reason = buildEscalationReason(verdict);
  assert.match(reason, /add a second bag to next order/);
  assert.match(reason, /apply \$15 credit/);
});

// ── Positive path ───────────────────────────────────────────────────────

test("all outcomes verified → OK (auto-resolve allowed — Phase-4 verification bullet 2)", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add bag", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "$15 credit", status: "verified", verified_at: new Date().toISOString() }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, true);
});

test("empty outcome list → OK (a ticket with no required outcomes still auto-closes — backward compatible)", () => {
  const verdict = assessOutcomeCompletion([]);
  assert.equal(verdict.ok, true);
});

// ── done and failed are BOTH treated as unfinished ──────────────────────

test("any pending outcome → BLOCKED (executor hasn't fired yet)", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "cancel", description: "cancel next box", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "$15 credit", status: "pending" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false);
  const unfinished = (verdict as { unfinished_items: Array<{ description: string; status: string }> }).unfinished_items;
  assert.equal(unfinished.length, 1);
  assert.equal(unfinished[0].description, "$15 credit");
  assert.equal(unfinished[0].status, "pending");
});

test("any done outcome → BLOCKED (executor fired but DB verify hasn't confirmed — same non-ship-worthy state as pending)", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "apply_coupon", description: "$15 credit", status: "done" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false, "a done row means the handler returned success but the DB predicate hasn't been confirmed — not ship-worthy");
  const unfinished = (verdict as { unfinished_items: Array<{ status: string }> }).unfinished_items;
  assert.deepEqual(unfinished.map((u) => u.status), ["done"]);
});

test("any failed outcome → BLOCKED with failed_reason preserved on the item", () => {
  const outcomes = [
    fakeOutcome({
      id: "o1",
      kind: "apply_coupon",
      description: "$15 credit",
      status: "failed",
      failed_reason: "coupon executor refused: applied_discounts already contains JUDY15",
    }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false);
  const unfinished = (verdict as { unfinished_items: Array<{ failed_reason?: string }> }).unfinished_items;
  assert.match(unfinished[0].failed_reason ?? "", /coupon executor refused/);
});

test("mixed pending + done + failed + verified → BLOCKED, all THREE non-verified named", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add bag", status: "pending" }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "$15 credit", status: "done" }),
    fakeOutcome({ id: "o3", kind: "cancel", description: "cancel next box", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o4", kind: "partial_refund", description: "$25 refund", status: "failed", failed_reason: "no card on file" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false);
  const unfinished = (verdict as { unfinished_items: Array<{ description: string }> }).unfinished_items;
  assert.equal(unfinished.length, 3);
  const descs = unfinished.map((u) => u.description).sort();
  assert.deepEqual(descs, ["$15 credit", "$25 refund", "add bag"]);
});

// ── WAIVE: a waived outcome is terminal-closed — the gate opens on it (ticket aaf00047) ──────

test("waived outcome is terminal-closed → gate OK (not counted as unfinished)", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "cancel", description: "cancel", status: "verified", verified_at: new Date().toISOString() }),
    fakeOutcome({ id: "o2", kind: "apply_loyalty_coupon", description: "apply LOYALTY-15", status: "waived", failed_reason: "policy-forbidden on a paused sub" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, true, "a waived (correctly-not-done) row must NOT keep the ticket open");
});

test("the loop state: a lone FAILED policy-forbidden coupon row still BLOCKS until it is waived", () => {
  // Before the waive pass runs, the stuck failed row keeps re-escalating — this is the bug.
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "apply_loyalty_coupon", description: "apply LOYALTY-15", status: "failed", failed_reason: "subscription_not_active" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  assert.equal(verdict.ok, false, "a failed row loops the gate — the waive pass is what closes it");
});

// ── The pure policy predicate ────────────────────────────────────────────

test("assessPolicyForbidden: coupon apply on a paused/cancelled sub is forbidden; active is not", () => {
  assert.equal(assessPolicyForbidden("apply_loyalty_coupon", "paused").forbidden, true);
  assert.equal(assessPolicyForbidden("apply_coupon", "cancelled").forbidden, true);
  assert.equal(assessPolicyForbidden("apply_loyalty_coupon", "active").forbidden, false);
  // Fail-closed on absent evidence + non-coupon kinds.
  assert.equal(assessPolicyForbidden("apply_loyalty_coupon", null).forbidden, false);
  assert.equal(assessPolicyForbidden("cancel", "paused").forbidden, false);
});

// ── WAIVE wire-in: closes the stuck failed row against a live paused sub, idempotent ─────────

type GateRow = Record<string, unknown>;

function fakeWaiveAdmin(seed: {
  outcomes: GateRow[];
  subs: Map<string, GateRow>; // key = shopify_contract_id
}): { admin: SupabaseClient; outcomes: GateRow[] } {
  const outcomes = seed.outcomes;
  const admin = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      if (table === "ticket_required_outcomes") {
        const q: Record<string, unknown> = {
          select: () => q,
          eq(col: string, val: unknown) { filters[col] = val; return q; },
          order: () => q,
          async then(resolve: (v: { data: GateRow[]; error: null }) => void) {
            // listRequiredOutcomes await — return all seeded rows for the ticket.
            resolve({ data: outcomes.slice(), error: null });
          },
          // UPDATE path (markOutcomeWaived → transitionStatus): patch is applied via update().
          update(patch: Record<string, unknown>) {
            return {
              eq(c: string, v: unknown) { filters[c] = v; return this; },
              async select() {
                const row = outcomes.find(
                  (o) => o.id === filters["id"] && o.status === filters["status"],
                );
                if (!row) return { data: [], error: null };
                Object.assign(row, patch);
                return { data: [row], error: null };
              },
            };
          },
        };
        return q;
      }
      // subscriptions read
      const sq = {
        select: () => sq,
        eq(col: string, val: unknown) { filters[col] = val; return sq; },
        async maybeSingle() {
          const row = seed.subs.get(String(filters["shopify_contract_id"] ?? "")) ?? null;
          return { data: row, error: null };
        },
      };
      return sq;
    },
  } as unknown as SupabaseClient;
  return { admin, outcomes };
}

test("waivePolicyForbiddenOutcomes: closes a FAILED apply_loyalty_coupon row on a paused sub", async () => {
  const outcomes: GateRow[] = [
    {
      id: "o1", workspace_id: "w1", ticket_id: "t1", kind: "apply_loyalty_coupon",
      description: "apply LOYALTY-15", target_ids: { contract_id: "gid://paused", code: "LOYALTY-15" },
      status: "failed", failed_reason: "subscription_not_active",
    },
  ];
  const subs = new Map<string, GateRow>([["gid://paused", { status: "paused" }]]);
  const { admin } = fakeWaiveAdmin({ outcomes, subs });
  const { waived } = await waivePolicyForbiddenOutcomes({ admin, workspace_id: "w1", ticket_id: "t1" });
  assert.equal(waived.length, 1);
  assert.equal(waived[0].kind, "apply_loyalty_coupon");
  assert.equal(outcomes[0].status, "waived", "the row is CAS-moved to waived");

  // Idempotent — a second pass finds the row already waived and does nothing.
  const second = await waivePolicyForbiddenOutcomes({ admin, workspace_id: "w1", ticket_id: "t1" });
  assert.equal(second.waived.length, 0);
});

test("waivePolicyForbiddenOutcomes: leaves a coupon row on an ACTIVE sub open (not policy-forbidden)", async () => {
  const outcomes: GateRow[] = [
    {
      id: "o1", workspace_id: "w1", ticket_id: "t1", kind: "apply_loyalty_coupon",
      description: "apply LOYALTY-15", target_ids: { contract_id: "gid://active" },
      status: "failed", failed_reason: "transient error",
    },
  ];
  const subs = new Map<string, GateRow>([["gid://active", { status: "active" }]]);
  const { admin } = fakeWaiveAdmin({ outcomes, subs });
  const { waived } = await waivePolicyForbiddenOutcomes({ admin, workspace_id: "w1", ticket_id: "t1" });
  assert.equal(waived.length, 0, "an active-sub failure is a real failure, not a policy waive");
  assert.equal(outcomes[0].status, "failed");
});

test("waivePolicyForbiddenOutcomes: fail-closed when target_ids has no contract_id", async () => {
  const outcomes: GateRow[] = [
    {
      id: "o1", workspace_id: "w1", ticket_id: "t1", kind: "apply_loyalty_coupon",
      description: "apply LOYALTY-15", target_ids: {}, status: "failed", failed_reason: "x",
    },
  ];
  const { admin } = fakeWaiveAdmin({ outcomes, subs: new Map() });
  const { waived } = await waivePolicyForbiddenOutcomes({ admin, workspace_id: "w1", ticket_id: "t1" });
  assert.equal(waived.length, 0);
  assert.equal(outcomes[0].status, "failed", "no contract id → leave open for a human");
});

// ── Escalation reason shape ─────────────────────────────────────────────

test("buildEscalationReason: names count + descriptions + statuses", () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add bag", status: "pending" }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "$15 credit", status: "failed", failed_reason: "no code" }),
  ];
  const verdict = assessOutcomeCompletion(outcomes);
  const reason = buildEscalationReason(verdict);
  assert.match(reason, /2 required outcome/);
  assert.match(reason, /pending/);
  assert.match(reason, /failed/);
  assert.match(reason, /add bag/);
  assert.match(reason, /\$15 credit/);
});

test("buildEscalationReason on an OK verdict is an empty string (nothing to escalate)", () => {
  const outcomes = [fakeOutcome({ id: "o1", kind: "cancel", description: "cancel", status: "verified", verified_at: new Date().toISOString() })];
  const verdict = assessOutcomeCompletion(outcomes);
  const reason = buildEscalationReason(verdict);
  assert.equal(reason, "");
});

// ── Truncation safety on the reason ─────────────────────────────────────

test("buildEscalationReason: many items → reason stays under the 500-char field cap (tickets.escalation_reason)", () => {
  const outcomes = Array.from({ length: 40 }, (_, i) =>
    fakeOutcome({
      id: `o${i}`,
      kind: "apply_coupon",
      description: `credit item number ${i} with a very long detailed description of what needs to happen`,
      status: "pending",
    }),
  );
  const verdict = assessOutcomeCompletion(outcomes);
  const reason = buildEscalationReason(verdict);
  assert.ok(reason.length <= 500, `reason must fit in escalation_reason (500 char cap), got ${reason.length}`);
  assert.match(reason, /40 required outcome/);
});
