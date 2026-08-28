/**
 * Phase 1 of docs/brain/specs/closing-a-ticket-must-not-destroy-an-active-escalation.md.
 *
 * The old closeTicket unconditionally set escalated_to=null / escalated_at=null /
 * escalation_reason=(opts.reason??null), so a founder-escalated ticket that got closed became
 * indistinguishable from a ticket that had never been escalated. Ticket 6b0cd91c (Denise
 * Richling, 2026-08-28) auto-closed 4h after a founder escalation with all three columns
 * cleared and $102.33 still outstanding — nine such cases accumulated silently in 21 days.
 *
 * These tests pin the new contract:
 *   - default close preserves the escalation triple (audit trail survives)
 *   - `clearEscalation: true` (deliberate founder close) clears ownership but retains the
 *     escalation_reason as history
 *   - `reason` is only written when explicitly passed (never silently nulled)
 *   - always stamps status='closed', closed_at, updated_at
 *
 * Run: npx tsx --test src/lib/tickets-mutate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { closeTicket } from "./tickets-mutate";

function makeAdmin() {
  let captured: {
    table?: string;
    payload?: Record<string, unknown>;
    filters?: Record<string, unknown>;
  } | null = null;
  const admin = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        update(p: Record<string, unknown>) {
          captured = { table, payload: p, filters };
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        then(resolve: (v: { error: null }) => void) {
          resolve({ error: null });
        },
      };
      return builder;
    },
  };
  return {
    admin: admin as unknown as import("@supabase/supabase-js").SupabaseClient,
    captured: () => captured,
  };
}

const TID = "00000000-0000-0000-0000-0000000000ff";

test("closeTicket no longer blanket-nulls escalated_to (the 6b0cd91c regression) — preserves the escalation triple by default", async () => {
  const { admin, captured } = makeAdmin();
  await closeTicket(admin, TID);
  const c = captured();
  assert.ok(c, "update must fire");
  assert.equal(c!.table, "tickets");
  const payload = c!.payload as Record<string, unknown>;
  // status + timestamps are stamped
  assert.equal(payload.status, "closed");
  assert.equal(typeof payload.closed_at, "string");
  assert.equal(typeof payload.updated_at, "string");
  // The escalation triple is NOT in the update — the row's history survives.
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload, "escalated_to"),
    false,
    "escalated_to must not be nulled on a default close — the founder decision must survive",
  );
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "escalated_at"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "escalation_reason"), false);
});

test("closeTicket({ clearEscalation: true }) — deliberate founder close: clears ownership but preserves escalation_reason as audit", async () => {
  const { admin, captured } = makeAdmin();
  await closeTicket(admin, TID, { clearEscalation: true });
  const c = captured();
  const payload = c!.payload as Record<string, unknown>;
  assert.equal(payload.status, "closed");
  assert.equal(payload.escalated_to, null, "founder ruled on it → clear ownership");
  assert.equal(payload.escalated_at, null, "no longer actively escalated");
  // escalation_reason NOT in the update — the audit of WHY it was escalated survives.
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload, "escalation_reason"),
    false,
    "escalation_reason must survive as the historical audit even on a founder close",
  );
});

test("closeTicket({ reason }) explicitly overwrites escalation_reason when passed (rare — a resolution summary distinct from the original)", async () => {
  const { admin, captured } = makeAdmin();
  await closeTicket(admin, TID, { reason: "resolved by founder ruling" });
  const c = captured();
  const payload = c!.payload as Record<string, unknown>;
  assert.equal(payload.escalation_reason, "resolved by founder ruling");
});

test("closeTicket update is scoped by ticket id", async () => {
  const { admin, captured } = makeAdmin();
  await closeTicket(admin, TID);
  const c = captured();
  assert.deepEqual(c!.filters, { id: TID });
});
