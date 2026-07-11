/**
 * Unit tests for Phase 3 of
 * docs/brain/specs/account-linking-address-aware-confidence-graded-and-cs-searchable.md.
 *
 * The spec's failing state: a parked `ticket-handle` job (owner='cs' via `ownerFunctionForKind`)
 * surfaces as a Platform (Ada) → CEO card instead of routing to the CS Director (June) first.
 * The four tests below pin the invariants the routing predicate + applier must satisfy:
 *
 *   1. `decideCsOwnerRoute` returns `route_to='cs'` for kind='ticket-handle' + a ticket_id in
 *      instructions — the wedge.
 *   2. `decideCsOwnerRoute` returns `route_to=null` for a non-CS-owned kind (e.g. 'build') so
 *      the generic Platform sweep continues to route it — the router MUST NOT hijack
 *      Platform-owned parks.
 *   3. `applyCsOwnerRoute` enqueues a `cs-director-call` for the ticket, records a
 *      `director_activity` with `directorFunction='cs'` (owner-function attribution, not
 *      Platform), and compare-and-set flips the parked row to `completed` +
 *      `routed_cs_owner` — the terminal that keeps the row out of the 70-min invariant alarm.
 *   4. `applyCsOwnerRoute` on a row whose ticket already has an inflight cs-director-call
 *      is a no-op (returns `already_inflight`; no second enqueue).
 *
 * Run: npx tsx --test src/lib/agents/needs-attention-route-cs-owner.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideCsOwnerRoute,
  applyCsOwnerRoute,
  CS_FUNCTION,
  CS_ROUTED_MARKER,
  type ParkedRowLike,
} from "./needs-attention-route-cs-owner";

const WS = "00000000-0000-0000-0000-0000000000ws";
const PARKED_ID = "22222222-3333-4444-5555-666666666666";
const TICKET_ID = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";

const parked = (over: Partial<ParkedRowLike> = {}): ParkedRowLike => ({
  id: PARKED_ID,
  workspace_id: WS,
  kind: "ticket-handle",
  spec_slug: `ticket-handle-${TICKET_ID.slice(0, 8)}`,
  instructions: JSON.stringify({ ticket_id: TICKET_ID, workspace_id: WS, turn_index: 1, reason: "first_touch" }),
  error: "session timed out mid-Direction",
  log_tail: "[handle] Sol session claimed but did not conclude",
  ...over,
});

test("decideCsOwnerRoute: ticket-handle park + ticket_id in instructions → route_to='cs'", () => {
  const d = decideCsOwnerRoute(parked());
  assert.equal(d.route_to, "cs", "a ticket-handle park must route to CS, not fall through to Platform/CEO");
  assert.equal(d.ticket_id, TICKET_ID);
});

test("decideCsOwnerRoute: ticket-analyze park + ticket_id in instructions → route_to='cs'", () => {
  const d = decideCsOwnerRoute(parked({ kind: "ticket-analyze" }));
  assert.equal(d.route_to, "cs");
  assert.equal(d.ticket_id, TICKET_ID);
});

test("decideCsOwnerRoute: non-CS-owned kind (e.g. 'build') → route_to=null (Platform sweep still owns it)", () => {
  const d = decideCsOwnerRoute(parked({ kind: "build" }));
  assert.equal(d.route_to, null, "the CS router must NOT hijack Platform-owned parks");
  assert.equal(d.ticket_id, null);
});

test("decideCsOwnerRoute: CS-owned kind without a resolvable ticket_id → route_to=null (fall through)", () => {
  const d = decideCsOwnerRoute(parked({ instructions: null }));
  assert.equal(d.route_to, null, "no ticket_id → no cs-director-call to enqueue → don't dispatch");
});

test("decideCsOwnerRoute: instructions that don't parse → route_to=null (defensive read, no throw)", () => {
  const d = decideCsOwnerRoute(parked({ instructions: "not-json" }));
  assert.equal(d.route_to, null);
});

// ── applyCsOwnerRoute ────────────────────────────────────────────────────────────

interface FakeJob { id: string; workspace_id: string; kind: string; spec_slug: string | null; status: string }
interface FakeDirectorActivity {
  workspace_id: string;
  director_function: string;
  action_kind: string;
  spec_slug: string | null;
  reason: string;
  metadata: Record<string, unknown> | null;
}

function makeAdmin(seed: { agent_jobs?: FakeJob[] } = {}) {
  const state = {
    agent_jobs: (seed.agent_jobs ?? []).map((j) => ({ ...j })),
    inserted_cs_calls: [] as Array<Record<string, unknown>>,
    director_activity: [] as FakeDirectorActivity[],
    updates: [] as Array<{ id: string; patch: Record<string, unknown>; where_status: string }>,
  };

  function makeAgentJobsBuilder() {
    const filters: Record<string, unknown> = {};
    const statusFilterIn: string[] = [];
    let insertPayload: Record<string, unknown> | null = null;
    let updatePatch: Record<string, unknown> | null = null;
    const builder = {
      select(_c: string) { return builder; },
      eq(col: string, val: unknown) { filters[col] = val; return builder; },
      in(col: string, vals: string[]) { if (col === "status") statusFilterIn.push(...vals); return builder; },
      limit(_n: number) { return builder; },
      insert(payload: Record<string, unknown>) { insertPayload = payload; return builder; },
      update(patch: Record<string, unknown>) { updatePatch = patch; return builder; },
      single() {
        if (insertPayload) {
          const id = `cs-${state.inserted_cs_calls.length + 1}`;
          state.inserted_cs_calls.push({ id, ...insertPayload });
          return Promise.resolve({ data: { id }, error: null });
        }
        // maybeSingle-style read
        const match = state.agent_jobs.find((j) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((j as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          if (statusFilterIn.length && !statusFilterIn.includes(j.status)) return false;
          return true;
        });
        return Promise.resolve({ data: match ? { id: match.id } : null, error: null });
      },
      maybeSingle() { return builder.single(); },
    };
    // The read path in applyCsOwnerRoute uses .select().eq().in().limit() then awaits directly
    // (not .single) — expose a `then` so `await builder` resolves to a { data, error } shape
    // that mirrors what supabase-js returns for a range read.
    (builder as unknown as PromiseLike<{ data: Array<{ id: string }>; error: null }>).then = ((
      resolve: (v: { data: Array<{ id: string }>; error: null }) => void,
    ) => {
      const results = state.agent_jobs.filter((j) => {
        for (const [k, v] of Object.entries(filters)) {
          if ((j as unknown as Record<string, unknown>)[k] !== v) return false;
        }
        if (statusFilterIn.length && !statusFilterIn.includes(j.status)) return false;
        return true;
      }).map((j) => ({ id: j.id }));
      resolve({ data: results, error: null });
    }) as unknown as typeof Promise.prototype.then;
    // The update path in applyCsOwnerRoute is .update({…}).eq('id',…).eq('status','needs_attention').select('id')
    // and awaits the .select() result. Rewire so this shape returns { data, error } with the
    // row-count semantics the applier reads.
    const originalSelect = builder.select;
    builder.select = (_c: string) => {
      if (updatePatch) {
        const idx = state.agent_jobs.findIndex((j) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((j as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        });
        const doApply = idx >= 0;
        if (doApply) {
          state.agent_jobs[idx] = { ...state.agent_jobs[idx], ...(updatePatch as Partial<FakeJob>) };
          state.updates.push({
            id: state.agent_jobs[idx].id,
            patch: updatePatch,
            where_status: String(filters.status ?? ""),
          });
        }
        const data = doApply ? [{ id: state.agent_jobs[idx].id }] : [];
        return { then: (resolve: (v: { data: Array<{ id: string }>; error: null }) => void) => resolve({ data, error: null }) } as unknown as typeof builder;
      }
      return originalSelect(_c);
    };
    return builder;
  }

  function makeDirectorActivityBuilder() {
    return {
      insert(payload: FakeDirectorActivity) { state.director_activity.push({ ...payload }); return Promise.resolve({ data: null, error: null }); },
    };
  }

  const admin = {
    from(table: string) {
      if (table === "agent_jobs") return makeAgentJobsBuilder();
      if (table === "director_activity") return makeDirectorActivityBuilder();
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { admin: admin as unknown as import("@supabase/supabase-js").SupabaseClient, state };
}

test("applyCsOwnerRoute: enqueues cs-director-call + CS-attributed director_activity + flips parked row terminal", async () => {
  const { admin, state } = makeAdmin({
    agent_jobs: [
      { id: PARKED_ID, workspace_id: WS, kind: "ticket-handle", spec_slug: `ticket-handle-${TICKET_ID.slice(0, 8)}`, status: "needs_attention" },
    ],
  });
  const row = parked();
  const decision = decideCsOwnerRoute(row);
  const res = await applyCsOwnerRoute(admin, row, decision);
  assert.equal(res.routed, true);
  assert.equal(res.reason, "enqueued_cs_director_call");
  assert.ok(res.cs_director_call_job_id, "must return the enqueued job id");

  // 1) cs-director-call enqueued with the ticket_id as spec_slug + parked_from context
  assert.equal(state.inserted_cs_calls.length, 1);
  const cs = state.inserted_cs_calls[0] as { kind: string; workspace_id: string; spec_slug: string; instructions: string };
  assert.equal(cs.kind, "cs-director-call");
  assert.equal(cs.workspace_id, WS);
  assert.equal(cs.spec_slug, TICKET_ID);
  const csInstructions = JSON.parse(cs.instructions) as { ticket_id: string; parked_from: { kind: string; job_id: string } };
  assert.equal(csInstructions.ticket_id, TICKET_ID);
  assert.equal(csInstructions.parked_from.kind, "ticket-handle");
  assert.equal(csInstructions.parked_from.job_id, PARKED_ID);

  // 2) director_activity is attributed to CS, NOT Platform — the whole point of Phase 3
  assert.equal(state.director_activity.length, 1);
  const da = state.director_activity[0];
  assert.equal(da.director_function, CS_FUNCTION, "the owner function (cs) must claim the escalation, not platform");
  assert.equal(da.action_kind, "routed_needs_attention");
  assert.equal((da.metadata as { target_kind: string }).target_kind, "ticket-handle");

  // 3) compare-and-set flip: parked row is terminal (status='completed'), marked routed_cs_owner
  assert.equal(state.updates.length, 1);
  const upd = state.updates[0];
  assert.equal(upd.where_status, "needs_attention", "compare-and-set MUST re-assert needs_attention (Learning #9)");
  assert.equal((upd.patch as { status: string }).status, "completed");
  assert.equal((upd.patch as { needs_attention_class: string }).needs_attention_class, CS_ROUTED_MARKER);
});

test("applyCsOwnerRoute: inflight cs-director-call on the ticket → already_inflight (no second enqueue)", async () => {
  const { admin, state } = makeAdmin({
    agent_jobs: [
      { id: PARKED_ID, workspace_id: WS, kind: "ticket-handle", spec_slug: `ticket-handle-${TICKET_ID.slice(0, 8)}`, status: "needs_attention" },
      { id: "cs-existing", workspace_id: WS, kind: "cs-director-call", spec_slug: TICKET_ID, status: "queued" },
    ],
  });
  const row = parked();
  const res = await applyCsOwnerRoute(admin, row, decideCsOwnerRoute(row));
  assert.equal(res.routed, false);
  assert.equal(res.reason, "already_inflight", "a queued cs-director-call already gives June her chance — never double-enqueue");
  assert.equal(state.inserted_cs_calls.length, 0);
  assert.equal(state.director_activity.length, 0);
  assert.equal(state.updates.length, 0, "the parked row must stay put until June's job finishes");
});

test("applyCsOwnerRoute: on a non-CS decision → returns not_cs_owned without mutating anything", async () => {
  const { admin, state } = makeAdmin({ agent_jobs: [{ id: PARKED_ID, workspace_id: WS, kind: "build", spec_slug: "some-spec", status: "needs_attention" }] });
  const row = parked({ kind: "build" });
  const res = await applyCsOwnerRoute(admin, row, decideCsOwnerRoute(row));
  assert.equal(res.routed, false);
  assert.equal(res.reason, "not_cs_owned");
  assert.equal(state.inserted_cs_calls.length, 0);
  assert.equal(state.director_activity.length, 0);
});
