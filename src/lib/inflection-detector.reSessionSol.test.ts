/**
 * Unit tests for reSessionSol — Phase 3 of
 * docs/brain/specs/sol-drift-frustration-detector-and-re-session-router.md.
 *
 * The spec pins four behaviors we can exercise against an in-memory Supabase stub without a
 * live DB (the box has no prod creds — matching the pattern in
 * src/lib/storefront/experiment-delivery-audit.test.ts):
 *   - live Direction + frustration → supersede fires + agent_jobs row inserted with the
 *     spec-required payload (`reason:'inflection'`, `kind`, `evidence`, `superseded_direction_id`).
 *   - drift branch behaves identically for the router (holding-message is the caller's job).
 *   - no live Direction (compare-and-set race) → no supersede + NO enqueue (router must not
 *     fan out a redundant session when the invariant already flipped).
 *   - the router NEVER writes to `ticket_messages` — the box session sends the corrected reply.
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/inflection-detector.reSessionSol.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { reSessionSol, type InflectionEvidence } from "./inflection-detector";

interface FakeDirection {
  id: string;
  workspace_id: string;
  ticket_id: string;
  intent: string;
  context_summary: string;
  chosen_path: string;
  plan: Record<string, unknown>;
  guardrails: Record<string, unknown>;
  authored_by: string;
  authored_at: string;
  superseded_at: string | null;
}

interface FakeJob {
  id: string;
  workspace_id: string;
  kind: string;
  spec_slug: string;
  status: string;
  instructions: string;
}

function makeAdmin(seed: { directions: FakeDirection[]; nextJobId?: string }) {
  const state = {
    directions: seed.directions.map((d) => ({ ...d })),
    jobs: [] as FakeJob[],
    // The router must never touch ticket_messages. Any write here fails the test.
    ticketMessageWrites: 0,
  };
  let nextJobId = seed.nextJobId ?? "job-generated";

  function fromDirections() {
    // supersede path only: .update({superseded_at}).eq("ticket_id",…).is("superseded_at", null)
    //   [.eq("workspace_id", …)].select(COLS)
    const filters: Record<string, unknown> = {};
    let onlyLive = false;
    const builder = {
      update(patch: Record<string, unknown>) {
        (builder as unknown as { _patch: Record<string, unknown> })._patch = patch;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      is(col: string, val: unknown) {
        if (col === "superseded_at" && val === null) onlyLive = true;
        return builder;
      },
      select(_cols: string) {
        // Apply the filter set to state.directions, mutate matches with the patch.
        const patch = (builder as unknown as { _patch: Record<string, unknown> })._patch ?? {};
        const matches = state.directions.filter((d) => {
          if (onlyLive && d.superseded_at !== null) return false;
          for (const [k, v] of Object.entries(filters)) {
            if ((d as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        });
        for (const m of matches) Object.assign(m, patch);
        return Promise.resolve({ data: matches, error: null });
      },
    };
    return builder;
  }

  function fromAgentJobs() {
    return {
      insert(row: Record<string, unknown>) {
        const job: FakeJob = {
          id: nextJobId,
          workspace_id: String(row.workspace_id),
          kind: String(row.kind),
          spec_slug: String(row.spec_slug),
          status: String(row.status),
          instructions: String(row.instructions ?? ""),
        };
        state.jobs.push(job);
        return {
          select(_cols: string) {
            return {
              single() {
                return Promise.resolve({ data: { id: job.id }, error: null });
              },
            };
          },
        };
      },
    };
  }

  const admin = {
    from(table: string) {
      if (table === "ticket_directions") return fromDirections();
      if (table === "agent_jobs") return fromAgentJobs();
      if (table === "ticket_messages") {
        state.ticketMessageWrites++;
        throw new Error(
          "reSessionSol must NOT touch ticket_messages — the router sends no customer-facing message",
        );
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { admin: admin as unknown as import("@supabase/supabase-js").SupabaseClient, state };
}

const WS = "00000000-0000-0000-0000-0000000000ws";
const TID = "11111111-2222-3333-4444-555555555555";

function seedLive(overrides: Partial<FakeDirection> = {}): FakeDirection {
  return {
    id: "dir-live",
    workspace_id: WS,
    ticket_id: TID,
    intent: "refund shipping delay",
    context_summary: "customer waiting on tracking",
    chosen_path: "stateless",
    plan: {},
    guardrails: {},
    authored_by: "sol_box_session",
    authored_at: "2026-07-08T00:00:00Z",
    superseded_at: null,
    ...overrides,
  };
}

const EV: InflectionEvidence = { stage: 1, reason: "stage1_frustration_cue", cues: ["refund_now"] };

test("frustration + live Direction → supersede fires + agent_jobs row carries the spec payload", async () => {
  const { admin, state } = makeAdmin({ directions: [seedLive()], nextJobId: "job-abc" });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    kind: "frustration",
    evidence: EV,
    turn_index: 3,
  });
  assert.equal(res.superseded, true);
  assert.equal(res.enqueued, true);
  assert.equal(res.superseded_direction_id, "dir-live");
  assert.equal(res.job_id, "job-abc");

  // The direction row is now stamped.
  const dir = state.directions.find((d) => d.id === "dir-live")!;
  assert.notEqual(dir.superseded_at, null);

  // Exactly one job row inserted.
  assert.equal(state.jobs.length, 1);
  const job = state.jobs[0]!;
  assert.equal(job.kind, "ticket-handle");
  assert.equal(job.workspace_id, WS);
  assert.equal(job.status, "queued");
  // spec_slug mirrors the first-touch pattern (worker routing uniformity).
  assert.equal(job.spec_slug, `ticket-handle-${TID.slice(0, 8)}`);

  const parsed = JSON.parse(job.instructions);
  assert.equal(parsed.ticket_id, TID);
  assert.equal(parsed.workspace_id, WS);
  assert.equal(parsed.turn_index, 3);
  assert.equal(parsed.reason, "inflection"); // spec-required
  assert.equal(parsed.kind, "frustration");
  assert.equal(parsed.superseded_direction_id, "dir-live");
  assert.deepEqual(parsed.evidence, EV);
});

test("drift branch: same supersede+enqueue shape — the holding-message policy is the caller's job", async () => {
  const { admin, state } = makeAdmin({ directions: [seedLive()] });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    kind: "drift",
    evidence: { stage: 1, reason: "stage1_drift_multi_signal", cues: ["turn_limit_approach"] },
  });
  assert.equal(res.superseded, true);
  assert.equal(res.enqueued, true);
  assert.equal(state.jobs.length, 1);
  assert.equal(JSON.parse(state.jobs[0]!.instructions).kind, "drift");
  // Router MUST NOT touch ticket_messages on either kind — a drift bounce is silent by default,
  // and even the frustration holding message is sent from the Phase-2 gate site, not here.
  assert.equal(state.ticketMessageWrites, 0);
});

test("no live Direction (racing supersede won) → NO enqueue (compare-and-set guard)", async () => {
  // The only direction row is already superseded — mimics a racing caller stamping it first.
  const superseded = seedLive({ id: "dir-old", superseded_at: "2026-07-08T00:00:01Z" });
  const { admin, state } = makeAdmin({ directions: [superseded] });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    kind: "frustration",
    evidence: EV,
  });
  assert.equal(res.superseded, false, "no live row → no supersede");
  assert.equal(res.enqueued, false, "must not fan out a redundant session when the race is lost");
  assert.equal(state.jobs.length, 0, "no agent_jobs row");
  assert.equal(res.superseded_direction_id, null);
  assert.equal(res.job_id, null);
});

test("no Direction row at all for this ticket → NO enqueue (idempotent no-op)", async () => {
  const { admin, state } = makeAdmin({ directions: [] });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    kind: "drift",
    evidence: EV,
  });
  assert.equal(res.superseded, false);
  assert.equal(res.enqueued, false);
  assert.equal(state.jobs.length, 0);
});

test("workspace scoping: a same-ticket-id row in a DIFFERENT workspace is NOT superseded", async () => {
  const otherWs = "99999999-0000-0000-0000-0000000000ws";
  const foreign = seedLive({ id: "dir-foreign", workspace_id: otherWs });
  const { admin, state } = makeAdmin({ directions: [foreign] });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    kind: "frustration",
    evidence: EV,
  });
  assert.equal(res.superseded, false, "workspace filter must exclude the foreign row");
  assert.equal(res.enqueued, false);
  const dir = state.directions.find((d) => d.id === "dir-foreign")!;
  assert.equal(dir.superseded_at, null, "foreign row must remain untouched");
});
