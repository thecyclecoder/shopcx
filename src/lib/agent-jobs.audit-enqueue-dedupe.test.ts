/**
 * merged-but-unstamped-specs-reach-the-audit-instead-of-being-dropped Phase 1 — pins the shared
 * `enqueueAuditSpecShippedStateIfDue` helper's dedupe contract that the reconciler hand-off + the
 * director-initiated `request-audit` path both rely on.
 *
 * Named failing state the spec calls out: a merged-but-unstamped spec must reach the audit lane
 * INSTEAD OF being silently dropped, AND the platform-director standing pass (every few minutes)
 * must not hot-loop by re-queuing an audit the runner already tried and couldn't resolve. The
 * helper's dedupe covers both cases (OPEN + RECENT TERMINAL); this suite pins that.
 *
 *   npx tsx --test src/lib/agent-jobs.audit-enqueue-dedupe.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  enqueueAuditSpecShippedStateIfDue,
  AUDIT_SPEC_SHIPPED_STATE_TERMINAL_DEDUPE_MS,
} from "./agent-jobs";

type Row = { id: string; status: string; updated_at?: string };

// A tiny in-memory Supabase-shaped stub: enough of the chain to satisfy the queries the helper runs
// (two `.select("id").eq(...).eq(...).eq(...).eq(...).in(...)` reads and, on miss, one `.insert(...)
// .select("id").single()` write). We record the eq filters we saw + the branch we resolved to so the
// tests can assert dedupe fired on the correct branch.
type StubOpts = {
  openRows?: Row[];
  recentRows?: Row[];
  onInsert?: (row: Record<string, unknown>) => Row;
};

function makeStubAdmin(opts: StubOpts): {
  admin: unknown;
  seenSelects: string[];
  insertedRows: Record<string, unknown>[];
} {
  const seenSelects: string[] = [];
  const insertedRows: Record<string, unknown>[] = [];
  const admin = {
    from(_table: string) {
      const state: { in_status?: string[]; gte?: { col: string; val: string }; select?: string; isInsert?: boolean; insertPayload?: Record<string, unknown> } = {};
      const chain = {
        select(cols: string) {
          state.select = cols;
          if (state.isInsert) {
            return {
              async single() {
                const row = opts.onInsert ? opts.onInsert(state.insertPayload!) : { id: `new-${insertedRows.length + 1}`, status: "queued" };
                insertedRows.push(state.insertPayload!);
                return { data: row, error: null };
              },
            };
          }
          return chain;
        },
        eq(_col: string, _val: string) { return chain; },
        in(col: string, vals: string[]) { if (col === "status") state.in_status = vals; return chain; },
        gte(col: string, val: string) { state.gte = { col, val }; return chain; },
        order(_col: string, _o: unknown) { return chain; },
        limit(_n: number) { return chain; },
        async maybeSingle(): Promise<{ data: Row | null }> {
          // Decide which branch this .select was for by looking at the status filter set on it.
          const statuses = state.in_status ?? [];
          const isOpenQuery = statuses.includes("queued") && statuses.includes("claimed");
          const isTerminalQuery = statuses.includes("completed") && statuses.includes("failed");
          if (isOpenQuery) {
            seenSelects.push("open");
            return { data: (opts.openRows && opts.openRows[0]) ?? null };
          }
          if (isTerminalQuery) {
            seenSelects.push("recent_terminal");
            return { data: (opts.recentRows && opts.recentRows[0]) ?? null };
          }
          return { data: null };
        },
        insert(payload: Record<string, unknown>) {
          state.isInsert = true;
          state.insertPayload = payload;
          return chain;
        },
      };
      return chain;
    },
  };
  return { admin, seenSelects, insertedRows };
}

test("no in-flight + no recent terminal → INSERTS a new audit job (the hand-off actually fires)", async () => {
  const { admin, seenSelects, insertedRows } = makeStubAdmin({});
  const res = await enqueueAuditSpecShippedStateIfDue("ws-1", "stranded-spec", {
    requestedBy: "reconciler:merged-phase",
    reason: "no shipped sibling to copy provenance from",
    adminClient: admin as never,
  });
  assert.deepEqual(seenSelects, ["open", "recent_terminal"]);
  assert.equal(res.enqueued, true);
  if (res.enqueued) assert.match(res.jobId, /^new-/);
  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].kind, "audit-spec-shipped-state");
  assert.equal(insertedRows[0].spec_slug, "stranded-spec");
  assert.equal(insertedRows[0].workspace_id, "ws-1");
  assert.equal(insertedRows[0].status, "queued");
});

test("open audit already exists → DEDUPES on 'open' and does NOT insert", async () => {
  const { admin, seenSelects, insertedRows } = makeStubAdmin({
    openRows: [{ id: "open-1", status: "queued" }],
  });
  const res = await enqueueAuditSpecShippedStateIfDue("ws-1", "stranded-spec", {
    requestedBy: "director:platform",
    reason: "director triggered",
    adminClient: admin as never,
  });
  assert.equal(seenSelects[0], "open");
  assert.equal(res.enqueued, false);
  if (!res.enqueued) {
    assert.equal(res.dedup, "open");
    assert.equal(res.existingJobId, "open-1");
  }
  assert.equal(insertedRows.length, 0);
});

test("no open + recent terminal audit within window → DEDUPES on 'recent_terminal' (the hot-loop guard)", async () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const { admin, seenSelects, insertedRows } = makeStubAdmin({
    recentRows: [{ id: "terminal-1", status: "completed", updated_at: recent }],
  });
  const res = await enqueueAuditSpecShippedStateIfDue("ws-1", "stranded-spec", {
    requestedBy: "reconciler:merged-phase",
    reason: "standing pass",
    adminClient: admin as never,
  });
  assert.deepEqual(seenSelects, ["open", "recent_terminal"]);
  assert.equal(res.enqueued, false);
  if (!res.enqueued) {
    assert.equal(res.dedup, "recent_terminal");
    assert.equal(res.existingJobId, "terminal-1");
  }
  assert.equal(insertedRows.length, 0);
});

test("dedupe window is 24h (matches the spec's per-day-ceiling requirement)", () => {
  assert.equal(AUDIT_SPEC_SHIPPED_STATE_TERMINAL_DEDUPE_MS, 24 * 60 * 60 * 1000);
});
