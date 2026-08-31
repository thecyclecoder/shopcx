/**
 * Unit tests for the red-main alarm (a-red-main-is-a-first-class-pipeline-alarm Phase 1).
 *
 * Node's built-in `node:test` — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/main-build-status.test.ts
 *
 * Pins the spec's stated invariants:
 *   1. a red HEAD returns the FIRST red sha (walked back), NOT the head itself
 *   2. a green main clears (dismisses) any open alarm card
 *   3. two consecutive sweeps over the SAME first_red_sha produce EXACTLY ONE notification
 *      (idempotency per first_red_sha)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  sweepMainBuildStatus,
  MAIN_BUILD_RED_ESCALATION_KIND,
  MAIN_BUILD_RED_ACTION_KIND,
  type MainBuildState,
} from "./main-build-status";

interface StubReadResult {
  state: MainBuildState;
  headSha: string | null;
  firstRedSha: string | null;
  firstRedSubject: string | null;
}

interface StubTables {
  dashboard_notifications: Array<Record<string, unknown>>;
  director_activity: Array<Record<string, unknown>>;
}

/**
 * A minimal Supabase-shaped in-memory stub. We support just enough of the chain shapes
 * the sweep uses: `.select().eq()*.limit()` (returns { data }), `.insert(row)` (returns
 * { error }), and `.update(patch).in(...).eq(...)` (returns { error }). The stored rows
 * are kept per-table so a follow-up read sees the prior insert (that's the whole point
 * of idempotency — pin #3).
 */
function makeStubAdmin(tables: StubTables) {
  const admin = {
    from(table: keyof StubTables) {
      const rows = tables[table];
      const state: {
        eqs: Array<[string, unknown]>;
        isInsert?: boolean;
        insertPayload?: Record<string, unknown>;
        isUpdate?: boolean;
        updatePayload?: Record<string, unknown>;
        inFilter?: { col: string; vals: unknown[] };
      } = { eqs: [] };

      const filterRows = (): Array<Record<string, unknown>> => {
        return rows.filter((row) => {
          for (const [col, val] of state.eqs) {
            if (col.includes("->>")) {
              // metadata->>foo lookups — read from metadata blob
              const [container, key] = col.split("->>");
              const md = (row[container] as Record<string, unknown> | null) ?? null;
              if (!md || md[key] !== val) return false;
            } else {
              if (row[col] !== val) return false;
            }
          }
          if (state.inFilter) {
            const { col, vals } = state.inFilter;
            if (!vals.includes(row[col])) return false;
          }
          return true;
        });
      };

      // Supabase's PostgREST builder is thenable — any await on the chain resolves to
      // `{ data, error }`. Mirror that so `.eq().eq()` (no terminal call) works too.
      const chain: Record<string, unknown> = {
        select(_cols: string) {
          return chain;
        },
        eq(col: string, val: unknown) {
          state.eqs.push([col, val]);
          return chain;
        },
        in(col: string, vals: unknown[]) {
          state.inFilter = { col, vals };
          return chain;
        },
        limit(_n: number) {
          return Promise.resolve({ data: filterRows(), error: null });
        },
        order(_col: string, _o: unknown) {
          return chain;
        },
        then(onFulfilled: (v: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
          return Promise.resolve({ data: filterRows(), error: null }).then(onFulfilled);
        },
        insert(payload: Record<string, unknown>) {
          state.isInsert = true;
          state.insertPayload = payload;
          rows.push({ ...payload });
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) {
          state.isUpdate = true;
          state.updatePayload = patch;
          return {
            in(col: string, vals: unknown[]) {
              state.inFilter = { col, vals };
              return {
                eq(eqCol: string, eqVal: unknown) {
                  state.eqs.push([eqCol, eqVal]);
                  const matched = filterRows();
                  for (const r of matched) Object.assign(r, patch);
                  return Promise.resolve({ error: null });
                },
              };
            },
            eq(col: string, val: unknown) {
              state.eqs.push([col, val]);
              const matched = filterRows();
              for (const r of matched) Object.assign(r, patch);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
      return chain;
    },
  };
  return admin;
}

const FIRST_RED_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function redHeadRead(): StubReadResult {
  return {
    state: "failure",
    headSha: HEAD_SHA,
    firstRedSha: FIRST_RED_SHA,
    firstRedSubject: "the commit that broke main",
  };
}

function greenHeadRead(): StubReadResult {
  return {
    state: "success",
    headSha: HEAD_SHA,
    firstRedSha: null,
    firstRedSubject: null,
  };
}

test("red HEAD alarm carries the FIRST red sha, not the head", async () => {
  const tables: StubTables = { dashboard_notifications: [], director_activity: [] };
  const admin = makeStubAdmin(tables);

  const res = await sweepMainBuildStatus({
    read: async () => redHeadRead(),
    admin: admin as never,
    workspaceId: "ws-1",
  });

  assert.equal(res.state, "failure");
  assert.equal(res.alarmed, true);
  assert.equal(res.firstRedSha, FIRST_RED_SHA);
  assert.notEqual(res.firstRedSha, HEAD_SHA);

  // The inserted card's metadata must reference the FIRST red sha (that's what a human
  // needs), and the dedupe_key must be keyed on it (so a follow-up sweep dedupes).
  assert.equal(tables.dashboard_notifications.length, 1);
  const card = tables.dashboard_notifications[0] as {
    metadata: { first_red_sha: string; dedupe_key: string; escalation_kind: string; head_sha: string };
  };
  assert.equal(card.metadata.first_red_sha, FIRST_RED_SHA);
  assert.equal(card.metadata.head_sha, HEAD_SHA);
  assert.equal(card.metadata.escalation_kind, MAIN_BUILD_RED_ESCALATION_KIND);
  assert.equal(card.metadata.dedupe_key, `main_build_red:${FIRST_RED_SHA}`);

  // director_activity carries the same audit row.
  assert.equal(tables.director_activity.length, 1);
  const activity = tables.director_activity[0] as {
    action_kind: string;
    director_function: string;
    metadata: { first_red_sha: string };
  };
  assert.equal(activity.action_kind, MAIN_BUILD_RED_ACTION_KIND);
  assert.equal(activity.director_function, "platform");
  assert.equal(activity.metadata.first_red_sha, FIRST_RED_SHA);
});

test("green main dismisses an open alarm card (auto-clear)", async () => {
  const tables: StubTables = {
    dashboard_notifications: [
      {
        id: "card-1",
        workspace_id: "ws-1",
        type: "agent_approval_request",
        dismissed: false,
        metadata: {
          escalation_kind: MAIN_BUILD_RED_ESCALATION_KIND,
          dedupe_key: `main_build_red:${FIRST_RED_SHA}`,
          first_red_sha: FIRST_RED_SHA,
        },
      },
    ],
    director_activity: [],
  };
  const admin = makeStubAdmin(tables);

  const res = await sweepMainBuildStatus({
    read: async () => greenHeadRead(),
    admin: admin as never,
    workspaceId: "ws-1",
  });

  assert.equal(res.state, "success");
  assert.equal(res.alarmed, false);
  assert.equal(res.resolved, true);
  // The card is still in the table but flipped dismissed:true.
  const card = tables.dashboard_notifications[0] as { dismissed: boolean };
  assert.equal(card.dismissed, true);
});

test("two consecutive sweeps over the same first_red_sha produce EXACTLY ONE notification", async () => {
  const tables: StubTables = { dashboard_notifications: [], director_activity: [] };
  const admin = makeStubAdmin(tables);

  // First sweep — raises the alarm.
  const first = await sweepMainBuildStatus({
    read: async () => redHeadRead(),
    admin: admin as never,
    workspaceId: "ws-1",
  });
  assert.equal(first.alarmed, true);
  assert.equal(tables.dashboard_notifications.length, 1);
  assert.equal(tables.director_activity.length, 1);

  // Second sweep — same first_red_sha, must dedupe. Zero new rows anywhere.
  const second = await sweepMainBuildStatus({
    read: async () => redHeadRead(),
    admin: admin as never,
    workspaceId: "ws-1",
  });
  assert.equal(second.alarmed, false);
  assert.equal(second.reason, "deduped");
  assert.equal(tables.dashboard_notifications.length, 1);
  assert.equal(tables.director_activity.length, 1);
});

test("state='unknown' (GitHub unreachable) is a no-op — never fake-clears, never alarms", async () => {
  const tables: StubTables = {
    dashboard_notifications: [
      {
        id: "card-1",
        workspace_id: "ws-1",
        type: "agent_approval_request",
        dismissed: false,
        metadata: { escalation_kind: MAIN_BUILD_RED_ESCALATION_KIND },
      },
    ],
    director_activity: [],
  };
  const admin = makeStubAdmin(tables);

  const res = await sweepMainBuildStatus({
    read: async () => ({ state: "unknown", headSha: null, firstRedSha: null, firstRedSubject: null }),
    admin: admin as never,
    workspaceId: "ws-1",
  });

  assert.equal(res.state, "unknown");
  assert.equal(res.alarmed, false);
  assert.equal(res.resolved, false);
  assert.equal(res.reason, "github_unreachable");
  // The open card is UNTOUCHED — a GitHub blip must never fake-clear a real red-main alarm.
  const card = tables.dashboard_notifications[0] as { dismissed: boolean };
  assert.equal(card.dismissed, false);
});
