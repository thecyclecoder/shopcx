/**
 * Unit tests for `enqueueSolFirstTouchForPortalError` — the Phase 1 helper that
 * routes a portal error to Sol's first-touch ticket-handle path (not the
 * cs-director-call / triage-escalations lane). Verifies:
 *   1. A fresh portal error inserts one `agent_jobs` row with kind='ticket-handle',
 *      spec_slug='ticket-handle-<first-8>', status='queued', and instructions carrying
 *      reason='portal_error' + workspace_id + ticket_id + route + error_code.
 *   2. An in-flight ticket-handle job for the same ticket dedupes — no second row inserted.
 *   3. No `cs-director-call` / `triage-escalations` row is inserted on the happy path.
 *
 * Uses a minimal chainable Supabase stub (no test-runner mock library) modelled on
 * the existing remediation.test.ts stub, extended to capture inserted rows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  enqueueSolFirstTouchForPortalError,
  specSlugForTicketHandle,
} from "./enqueue-sol-first-touch";

type Row = Record<string, unknown>;

class StubQuery {
  // `op` is the ROOT verb of the chain (insert/select). `.select()` after `.insert()`
  // does NOT downgrade to a read — it just projects columns on the inserted row —
  // so track the root separately from projection.
  private op: "select" | "insert" | null = null;
  private filters: Array<[string, string, unknown]> = [];
  private inFilters: Array<[string, unknown[]]> = [];
  private insertRow: Row | null = null;
  constructor(
    private table: string,
    private tables: Record<string, Row[]>,
    private inserted: Record<string, Row[]>,
  ) {}
  select(_cols: string) {
    // Only set the root to "select" if we haven't already started an insert.
    if (this.op !== "insert") this.op = "select";
    return this;
  }
  insert(body: Row) {
    this.op = "insert";
    if (!this.inserted[this.table]) this.inserted[this.table] = [];
    const row = { id: `stub_${this.table}_${this.inserted[this.table].length + 1}`, ...body };
    this.inserted[this.table].push(row);
    this.insertRow = row;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push(["eq", col, val]);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.inFilters.push([col, vals]);
    return this;
  }
  limit(_n: number) {
    if (this.op === "insert") {
      return Promise.resolve({ data: this.insertRow ? [this.insertRow] : [], error: null });
    }
    return Promise.resolve({ data: this.matched(), error: null });
  }
  single() {
    if (this.op === "insert") {
      return Promise.resolve({ data: this.insertRow, error: null });
    }
    return Promise.resolve({ data: this.matched()[0] ?? null, error: null });
  }
  private matched(): Row[] {
    return (this.tables[this.table] || []).filter((r) => {
      if (!this.filters.every(([op, col, val]) => (op === "eq" ? r[col] === val : true))) return false;
      if (!this.inFilters.every(([col, vals]) => vals.includes(r[col]))) return false;
      return true;
    });
  }
}

interface StubDb {
  admin: SupabaseClient;
  inserted: Record<string, Row[]>;
}

function stubDb(tables: Record<string, Row[]>): StubDb {
  const inserted: Record<string, Row[]> = {};
  const admin = {
    from: (table: string) => new StubQuery(table, tables, inserted),
  } as unknown as SupabaseClient;
  return { admin, inserted };
}

const WS = "ws_1";
const TID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("specSlugForTicketHandle uses the first 8 chars of the ticket id", () => {
  assert.equal(specSlugForTicketHandle(TID), `ticket-handle-${TID.slice(0, 8)}`);
});

test("enqueue inserts one ticket-handle job with the portal_error payload — happy path", async () => {
  const { admin, inserted } = stubDb({ agent_jobs: [] });
  const out = await enqueueSolFirstTouchForPortalError(admin, {
    workspace_id: WS,
    ticket_id: TID,
    route: "changedate",
    error_code: "would_remove_last_item",
  });
  assert.equal(out.enqueued, true);
  assert.equal(out.reason, null);
  assert.ok(out.job_id, "job id returned");

  // Exactly ONE agent_jobs row inserted — no cs-director-call, no triage-escalations.
  const rows = inserted.agent_jobs || [];
  assert.equal(rows.length, 1);
  const job = rows[0];
  assert.equal(job.workspace_id, WS);
  assert.equal(job.kind, "ticket-handle");
  assert.equal(job.spec_slug, `ticket-handle-${TID.slice(0, 8)}`);
  assert.equal(job.status, "queued");

  const instructions = JSON.parse(job.instructions as string) as {
    ticket_id?: string;
    workspace_id?: string;
    turn_index?: number;
    reason?: string;
    route?: string;
    error_code?: string | null;
  };
  assert.equal(instructions.ticket_id, TID);
  assert.equal(instructions.workspace_id, WS);
  assert.equal(instructions.reason, "portal_error");
  assert.equal(instructions.turn_index, 1);
  assert.equal(instructions.route, "changedate");
  assert.equal(instructions.error_code, "would_remove_last_item");

  // Verification bullet 3: no triage-escalation is enqueued on the happy path.
  const kinds = new Set(rows.map((r) => r.kind as string));
  assert.equal(kinds.has("cs-director-call"), false);
  assert.equal(kinds.has("triage-escalations"), false);
});

test("dedupe: an in-flight ticket-handle job for the same ticket skips the second enqueue", async () => {
  const { admin, inserted } = stubDb({
    agent_jobs: [
      {
        id: "job_pre",
        workspace_id: WS,
        kind: "ticket-handle",
        spec_slug: `ticket-handle-${TID.slice(0, 8)}`,
        status: "queued",
      },
    ],
  });
  const out = await enqueueSolFirstTouchForPortalError(admin, {
    workspace_id: WS,
    ticket_id: TID,
    route: "changedate",
    error_code: null,
  });
  assert.equal(out.enqueued, false);
  assert.equal(out.reason, "already_inflight");
  assert.equal(out.job_id, null);
  // Nothing new inserted — the stub's inserted table stays empty.
  assert.equal((inserted.agent_jobs || []).length, 0);
});

test("dedupe: a COMPLETED ticket-handle job does not block a fresh enqueue on a re-error", async () => {
  const { admin, inserted } = stubDb({
    agent_jobs: [
      {
        id: "job_done",
        workspace_id: WS,
        kind: "ticket-handle",
        spec_slug: `ticket-handle-${TID.slice(0, 8)}`,
        status: "completed",
      },
    ],
  });
  const out = await enqueueSolFirstTouchForPortalError(admin, {
    workspace_id: WS,
    ticket_id: TID,
    route: "frequency",
    error_code: "some_transient_code",
  });
  assert.equal(out.enqueued, true);
  assert.equal(out.reason, null);
  assert.equal((inserted.agent_jobs || []).length, 1);
});

test("dedupe: a ticket-handle job in a DIFFERENT workspace does not block this workspace", async () => {
  const { admin, inserted } = stubDb({
    agent_jobs: [
      {
        id: "job_other_ws",
        workspace_id: "ws_other",
        kind: "ticket-handle",
        spec_slug: `ticket-handle-${TID.slice(0, 8)}`,
        status: "queued",
      },
    ],
  });
  const out = await enqueueSolFirstTouchForPortalError(admin, {
    workspace_id: WS,
    ticket_id: TID,
    route: "removeLineItem",
    error_code: null,
  });
  assert.equal(out.enqueued, true);
  assert.equal((inserted.agent_jobs || []).length, 1);
});
