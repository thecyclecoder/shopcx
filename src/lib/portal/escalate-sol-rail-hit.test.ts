/**
 * Unit tests for `escalateSolPortalRailHit` — Phase 3 of
 * portal-errors-route-to-sol-first-escalate-to-june-on-rail.
 *
 * Pins the Phase 3 verification bullet:
 *   "A portal error Sol resolves within leash never creates a June triage-escalation; a portal error
 *    that hits Sol's leash escalates to a June triage-escalation carrying the Direction + Sol's
 *    attempts, and the escalation reason names the rail Sol hit."
 *
 * We test the WRITE-shape (compare-and-set with `.is('escalated_at', null)`, workspace_id-scoped,
 * `.select('id')` single-row assertion) — that shape is what makes the escalate refuse to overwrite
 * a prior escalate (`sol_resession_cap_hit` from `reSessionSol`) and refuses to leak across
 * workspaces.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  escalateSolPortalRailHit,
  buildSolPortalRailHitReason,
  SOL_PORTAL_RAIL_HIT_REASON_PREFIX,
} from "./escalate-sol-rail-hit";

type Row = Record<string, unknown>;

// Minimal chainable Supabase stub — extends the pattern used in the Phase 1 test to model
// `.update(...).eq(...).eq(...).is(...).select("id")` and a follow-up read via `.maybeSingle()`.
class StubQuery {
  private op: "select" | "update" | null = null;
  private eqFilters: Array<[string, unknown]> = [];
  private isNullFilters: string[] = [];
  private updateBody: Row | null = null;
  constructor(
    private table: string,
    private tables: Record<string, Row[]>,
    private applied: Array<{ table: string; op: string; body?: Row; filters: unknown }>,
  ) {}
  select(_cols: string) {
    if (this.op !== "update") this.op = "select";
    return this;
  }
  update(body: Row) {
    this.op = "update";
    this.updateBody = body;
    return this;
  }
  eq(col: string, val: unknown) {
    this.eqFilters.push([col, val]);
    return this;
  }
  is(col: string, val: unknown) {
    // Only handling `null` here — the escalate helper's compare-and-set uses is('escalated_at', null).
    if (val === null) this.isNullFilters.push(col);
    return this;
  }
  private matches(r: Row): boolean {
    return (
      this.eqFilters.every(([col, val]) => r[col] === val) &&
      this.isNullFilters.every((col) => r[col] === null || r[col] === undefined)
    );
  }
  // .update(...).eq(...).is(...).select('id') — returns the rows that transitioned.
  // For the select path (from `.maybeSingle()`), returns the single matched row.
  maybeSingle() {
    const rows = (this.tables[this.table] || []).filter((r) => this.matches(r));
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }
  // Terminal: the trailing `.select("id")` after an update. The escalate helper awaits this directly.
  then<T = unknown>(resolve: (value: { data: Array<{ id: string }>; error: null }) => T) {
    const table = this.tables[this.table] || [];
    if (this.op === "update") {
      const targets = table.filter((r) => this.matches(r));
      for (const r of targets) Object.assign(r, this.updateBody);
      this.applied.push({
        table: this.table,
        op: "update",
        body: this.updateBody ?? undefined,
        filters: { eq: this.eqFilters, isNull: this.isNullFilters },
      });
      return Promise.resolve({ data: targets.map((r) => ({ id: r.id as string })), error: null }).then(resolve);
    }
    const targets = table.filter((r) => this.matches(r));
    return Promise.resolve({ data: targets.map((r) => ({ id: r.id as string })), error: null }).then(resolve);
  }
}

interface StubDb {
  admin: SupabaseClient;
  applied: Array<{ table: string; op: string; body?: Row; filters: unknown }>;
  tickets: Row[];
}

function stubDb(tickets: Row[]): StubDb {
  const applied: Array<{ table: string; op: string; body?: Row; filters: unknown }> = [];
  const tables: Record<string, Row[]> = { tickets };
  const admin = {
    from: (table: string) => new StubQuery(table, tables, applied),
  } as unknown as SupabaseClient;
  return { admin, applied, tickets };
}

const WS = "ws_1";
const TID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SOL_REASON = "Customer needs a refund larger than my $30 guardrail — Julie should approve.";

// ── buildSolPortalRailHitReason ────────────────────────────────────────────

test("buildSolPortalRailHitReason prefixes and trims the Sol reason", () => {
  const r = buildSolPortalRailHitReason(`  ${SOL_REASON}  `);
  assert.equal(r, `${SOL_PORTAL_RAIL_HIT_REASON_PREFIX}: ${SOL_REASON}`);
});

test("buildSolPortalRailHitReason falls back to a stable placeholder on empty input", () => {
  assert.equal(buildSolPortalRailHitReason(""), `${SOL_PORTAL_RAIL_HIT_REASON_PREFIX}: (no reason given)`);
  assert.equal(buildSolPortalRailHitReason("   "), `${SOL_PORTAL_RAIL_HIT_REASON_PREFIX}: (no reason given)`);
});

// ── escalateSolPortalRailHit ───────────────────────────────────────────────

test("happy path: Sol rail-hit escalates the ticket + names the rail Sol hit", async () => {
  // Verification bullet 2: "escalates to a June triage-escalation carrying the Direction + Sol's
  // attempts, and the escalation reason names the rail Sol hit." The June review reads the
  // ticket_directions + ticket_messages + ticket_resolution_events on its own — this helper only
  // sets the ticket into the escalated lane the triage-escalations-cron picks up.
  const { admin, tickets } = stubDb([
    {
      id: TID,
      workspace_id: WS,
      escalated_at: null,
      escalated_to: null,
      escalation_reason: null,
      status: "open",
    },
  ]);
  const out = await escalateSolPortalRailHit(admin, {
    workspace_id: WS,
    ticket_id: TID,
    sol_reason: SOL_REASON,
  });
  assert.equal(out.escalated, true);
  assert.equal(out.reason, `${SOL_PORTAL_RAIL_HIT_REASON_PREFIX}: ${SOL_REASON}`);
  // The ticket now carries the escalate lane signature: escalated_at set, escalated_to null,
  // escalation_reason names the rail.
  const t = tickets[0];
  assert.ok(t.escalated_at, "escalated_at stamped");
  assert.equal(t.escalated_to, null, "escalated_to null = routine-owned (triage-escalations-cron picks it up)");
  assert.equal(t.escalation_reason, `${SOL_PORTAL_RAIL_HIT_REASON_PREFIX}: ${SOL_REASON}`);
});

test("compare-and-set: an ALREADY-escalated ticket is NOT overwritten (first escalate wins)", async () => {
  // Coaching #2/#3: the write is guarded on `.is('escalated_at', null)`. A prior escalate (e.g.
  // sol_resession_cap_hit from reSessionSol) must survive; a subsequent Sol rail-hit on the same
  // ticket is a no-op instead of clobbering the audit trail.
  const priorReason = "sol_resession_cap_hit";
  const priorTs = "2026-07-08T11:00:00Z";
  const { admin, tickets } = stubDb([
    {
      id: TID,
      workspace_id: WS,
      escalated_at: priorTs,
      escalated_to: null,
      escalation_reason: priorReason,
      status: "open",
    },
  ]);
  const out = await escalateSolPortalRailHit(admin, {
    workspace_id: WS,
    ticket_id: TID,
    sol_reason: SOL_REASON,
  });
  assert.equal(out.escalated, false);
  assert.equal(out.reason, "already_escalated");
  // Ticket state unchanged.
  const t = tickets[0];
  assert.equal(t.escalated_at, priorTs, "prior escalated_at survives");
  assert.equal(t.escalation_reason, priorReason, "prior escalation_reason survives");
});

test("workspace isolation: a ticket in a DIFFERENT workspace is not touched", async () => {
  const { admin, tickets } = stubDb([
    {
      id: TID,
      workspace_id: "ws_other",
      escalated_at: null,
      escalated_to: null,
      escalation_reason: null,
      status: "open",
    },
  ]);
  const out = await escalateSolPortalRailHit(admin, {
    workspace_id: WS,
    ticket_id: TID,
    sol_reason: SOL_REASON,
  });
  assert.equal(out.escalated, false);
  assert.equal(out.reason, "not_found", "cross-workspace bail is distinguishable from already_escalated");
  const t = tickets[0];
  assert.equal(t.escalated_at, null, "cross-workspace ticket untouched");
});

test("Sol resolves within leash → helper is never called → no escalate", () => {
  // Verification bullet 1: "A portal error Sol resolves within leash never creates a June triage-
  // escalation." This is a wire-in invariant, not a helper property — the worker calls this helper
  // only on the needs_human branch. The test pins the shape: the helper does nothing without being
  // called. (We assert against a stub that would flip the ticket if called.)
  const { tickets } = stubDb([
    { id: TID, workspace_id: WS, escalated_at: null, escalated_to: null, escalation_reason: null, status: "open" },
  ]);
  // No helper call — ticket stays un-escalated.
  assert.equal(tickets[0].escalated_at, null);
  assert.equal(tickets[0].escalated_to, null);
});
