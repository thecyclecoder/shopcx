/**
 * Unit tests for reSessionSol — Phase 3 of
 * docs/brain/specs/sol-drift-frustration-detector-and-re-session-router.md AND Phase 2 of
 * docs/brain/specs/sol-runaway-re-session-cap-guardrail.md (cap enforcement).
 *
 * The two specs together pin the router's behaviors — exercised against an in-memory Supabase
 * stub without a live DB (the box has no prod creds; same pattern as
 * src/lib/storefront/experiment-delivery-audit.test.ts):
 *   - live Direction + frustration (below cap) → increment resession_count, supersede fires,
 *     agent_jobs row inserted with the spec-required payload (`reason:'inflection'`, `kind`,
 *     `evidence`, `superseded_direction_id`).
 *   - drift branch behaves identically for the router (holding-message is the caller's job).
 *   - no live Direction (compare-and-set race) → no supersede + NO enqueue.
 *   - the router NEVER writes to `ticket_messages` — the box session sends the corrected reply.
 *   - cap-hit (sol_max_resessions IS NOT NULL AND resession_count >= sol_max_resessions) →
 *     NO supersede + NO agent_jobs insert; tickets.escalated_at set, escalated_to NULL,
 *     escalation_reason='sol_resession_cap_hit'; ticket_resolution_events row inserted with
 *     reasoning='sol:cap-hit' + evidence in `chosen`.
 *   - sol_max_resessions IS NULL → cap branch NEVER fires regardless of resession_count.
 *   - below-cap → resession_count increments by exactly 1 AND agent_jobs row inserted.
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
  resession_count: number;
}

interface FakeJob {
  id: string;
  workspace_id: string;
  kind: string;
  spec_slug: string;
  status: string;
  instructions: string;
}

interface FakeTicket {
  id: string;
  workspace_id: string;
  escalated_at: string | null;
  escalated_to: string | null;
  escalation_reason: string | null;
}

interface FakeChannelConfig {
  workspace_id: string;
  channel: string;
  sol_max_resessions: number | null;
}

interface FakeResolutionEvent {
  workspace_id: string;
  ticket_id: string;
  turn_index: number | null;
  reasoning: string;
  chosen: Record<string, unknown> | null;
}

interface SeedInput {
  directions: FakeDirection[];
  tickets?: FakeTicket[];
  channel_configs?: FakeChannelConfig[];
  nextJobId?: string;
}

function makeAdmin(seed: SeedInput) {
  const state = {
    directions: seed.directions.map((d) => ({ ...d })),
    jobs: [] as FakeJob[],
    tickets: (seed.tickets ?? []).map((t) => ({ ...t })),
    channel_configs: (seed.channel_configs ?? []).map((c) => ({ ...c })),
    resolution_events: [] as FakeResolutionEvent[],
    // The router must never touch ticket_messages. Any write here fails the test.
    ticketMessageWrites: 0,
  };
  let nextJobId = seed.nextJobId ?? "job-generated";

  function makeTableBuilder(rows: Array<Record<string, unknown>>) {
    const filters: Record<string, unknown> = {};
    let onlyLive = false;
    let mode: "select" | "update" | null = null;
    let patch: Record<string, unknown> = {};
    const builder = {
      select(_cols: string) {
        if (mode === null) mode = "select";
        // For update path this is the terminal action — return the matches.
        if (mode === "update") {
          const matches = rows.filter((d) => {
            if (onlyLive && (d as Record<string, unknown>).superseded_at !== null) return false;
            for (const [k, v] of Object.entries(filters)) {
              if ((d as Record<string, unknown>)[k] !== v) return false;
            }
            return true;
          });
          for (const m of matches) Object.assign(m, patch);
          return Promise.resolve({ data: matches, error: null });
        }
        // Select-mode chaining — return a builder that supports further filters + terminals.
        return builder;
      },
      update(p: Record<string, unknown>) {
        mode = "update";
        patch = p;
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
      maybeSingle() {
        const matches = rows.filter((d) => {
          if (onlyLive && (d as Record<string, unknown>).superseded_at !== null) return false;
          for (const [k, v] of Object.entries(filters)) {
            if ((d as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        });
        return Promise.resolve({ data: matches[0] ?? null, error: null });
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

  function fromResolutionEvents() {
    return {
      insert(row: Record<string, unknown>) {
        state.resolution_events.push({
          workspace_id: String(row.workspace_id),
          ticket_id: String(row.ticket_id),
          turn_index:
            typeof row.turn_index === "number"
              ? (row.turn_index as number)
              : row.turn_index === null
                ? null
                : null,
          reasoning: String(row.reasoning),
          chosen: (row.chosen as Record<string, unknown> | null) ?? null,
        });
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  const admin = {
    from(table: string) {
      if (table === "ticket_directions") {
        return makeTableBuilder(state.directions as unknown as Array<Record<string, unknown>>);
      }
      if (table === "agent_jobs") return fromAgentJobs();
      if (table === "tickets") {
        return makeTableBuilder(state.tickets as unknown as Array<Record<string, unknown>>);
      }
      if (table === "ai_channel_config") {
        return makeTableBuilder(
          state.channel_configs as unknown as Array<Record<string, unknown>>,
        );
      }
      if (table === "ticket_resolution_events") return fromResolutionEvents();
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
const CH = "email";

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
    resession_count: 0,
    ...overrides,
  };
}

function seedTicket(overrides: Partial<FakeTicket> = {}): FakeTicket {
  return {
    id: TID,
    workspace_id: WS,
    escalated_at: null,
    escalated_to: null,
    escalation_reason: null,
    ...overrides,
  };
}

function seedConfig(overrides: Partial<FakeChannelConfig> = {}): FakeChannelConfig {
  return { workspace_id: WS, channel: CH, sol_max_resessions: 3, ...overrides };
}

const EV: InflectionEvidence = { stage: 1, reason: "stage1_frustration_cue", cues: ["refund_now"] };

test("frustration + live Direction → supersede fires + agent_jobs row carries the spec payload", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    nextJobId: "job-abc",
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
    turn_index: 3,
  });
  assert.equal(res.superseded, true);
  assert.equal(res.enqueued, true);
  assert.equal(res.cap_hit, false);
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
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "drift",
    evidence: { stage: 1, reason: "stage1_drift_multi_signal", cues: ["turn_limit_approach"] },
  });
  assert.equal(res.superseded, true);
  assert.equal(res.enqueued, true);
  assert.equal(res.cap_hit, false);
  assert.equal(state.jobs.length, 1);
  assert.equal(JSON.parse(state.jobs[0]!.instructions).kind, "drift");
  assert.equal(state.ticketMessageWrites, 0);
});

test("no live Direction (racing supersede won) → NO enqueue (compare-and-set guard)", async () => {
  // The only direction row is already superseded — mimics a racing caller stamping it first.
  const superseded = seedLive({ id: "dir-old", superseded_at: "2026-07-08T00:00:01Z" });
  const { admin, state } = makeAdmin({
    directions: [superseded],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  assert.equal(res.superseded, false, "no live row → no supersede");
  assert.equal(res.enqueued, false, "must not fan out a redundant session when the race is lost");
  assert.equal(res.cap_hit, false);
  assert.equal(state.jobs.length, 0, "no agent_jobs row");
  assert.equal(res.superseded_direction_id, null);
  assert.equal(res.job_id, null);
});

test("no Direction row at all for this ticket → NO enqueue (idempotent no-op)", async () => {
  const { admin, state } = makeAdmin({
    directions: [],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "drift",
    evidence: EV,
  });
  assert.equal(res.superseded, false);
  assert.equal(res.enqueued, false);
  assert.equal(res.cap_hit, false);
  assert.equal(state.jobs.length, 0);
});

test("workspace scoping: a same-ticket-id row in a DIFFERENT workspace is NOT superseded", async () => {
  const otherWs = "99999999-0000-0000-0000-0000000000ws";
  const foreign = seedLive({ id: "dir-foreign", workspace_id: otherWs });
  const { admin, state } = makeAdmin({
    directions: [foreign],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  assert.equal(res.superseded, false, "workspace filter must exclude the foreign row");
  assert.equal(res.enqueued, false);
  const dir = state.directions.find((d) => d.id === "dir-foreign")!;
  assert.equal(dir.superseded_at, null, "foreign row must remain untouched");
});

// ── Phase 2 of sol-runaway-re-session-cap-guardrail — cap enforcement ─────────

test("cap-hit: resession_count=3 + sol_max_resessions=3 → NO enqueue, ticket escalated to routine, sol:cap-hit event stamped", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive({ resession_count: 3 })],
    tickets: [seedTicket()],
    channel_configs: [seedConfig({ sol_max_resessions: 3 })],
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
    turn_index: 5,
  });
  assert.equal(res.enqueued, false, "cap-hit must skip the agent_jobs insert");
  assert.equal(res.superseded, false, "cap-hit must NOT supersede the live Direction");
  assert.equal(res.cap_hit, true);
  assert.equal(state.jobs.length, 0);

  // Live Direction is NOT superseded (routine lane reads it as-is).
  const dir = state.directions.find((d) => d.id === "dir-live")!;
  assert.equal(dir.superseded_at, null);
  assert.equal(dir.resession_count, 3, "resession_count NOT incremented on cap-hit");

  // Ticket flipped to routine escalation.
  const t = state.tickets.find((row) => row.id === TID)!;
  assert.notEqual(t.escalated_at, null, "tickets.escalated_at must be set");
  assert.equal(t.escalated_to, null, "escalated_to NULL = routine lane");
  assert.equal(t.escalation_reason, "sol_resession_cap_hit");

  // Ledger stamp fired.
  assert.equal(state.resolution_events.length, 1);
  const ev = state.resolution_events[0]!;
  assert.equal(ev.reasoning, "sol:cap-hit");
  assert.equal(ev.turn_index, 5);
  assert.deepEqual(ev.chosen, {
    resession_count: 3,
    sol_max_resessions: 3,
    kind: "frustration",
  });
});

test("cap uncapped: sol_max_resessions IS NULL → cap branch NEVER fires regardless of resession_count", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive({ resession_count: 999 })],
    tickets: [seedTicket()],
    channel_configs: [seedConfig({ sol_max_resessions: null })],
    nextJobId: "job-null-cap",
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  assert.equal(res.cap_hit, false, "NULL sol_max_resessions is uncapped");
  assert.equal(res.superseded, true);
  assert.equal(res.enqueued, true);
  assert.equal(state.jobs.length, 1);
  // Ticket is NOT escalated when the cap is uncapped.
  const t = state.tickets.find((row) => row.id === TID)!;
  assert.equal(t.escalated_at, null);
  assert.equal(t.escalation_reason, null);
});

test("below cap: resession_count increments by exactly 1 + agent_jobs row inserted", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive({ resession_count: 1 })],
    tickets: [seedTicket()],
    channel_configs: [seedConfig({ sol_max_resessions: 3 })],
    nextJobId: "job-inc",
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "drift",
    evidence: { stage: 1, reason: "stage1_drift_multi_signal", cues: ["turn_limit_approach"] },
  });
  assert.equal(res.cap_hit, false);
  assert.equal(res.enqueued, true);
  assert.equal(res.superseded, true);
  assert.equal(state.jobs.length, 1);
  const dir = state.directions.find((d) => d.id === "dir-live")!;
  assert.equal(dir.resession_count, 2, "resession_count incremented by exactly 1 (1 → 2)");
  assert.notEqual(dir.superseded_at, null, "supersede fired after increment");
});

test("cap-hit workspace scoping: escalate is workspace-scoped (never touches a foreign ticket)", async () => {
  const otherWs = "99999999-0000-0000-0000-0000000000ws";
  const { admin, state } = makeAdmin({
    directions: [seedLive({ resession_count: 5 })],
    tickets: [
      seedTicket(),
      seedTicket({ id: TID, workspace_id: otherWs }), // same id, different workspace — must NOT be touched
    ],
    channel_configs: [seedConfig({ sol_max_resessions: 3 })],
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  assert.equal(res.cap_hit, true);
  const foreign = state.tickets.find((t) => t.workspace_id === otherWs)!;
  assert.equal(foreign.escalated_at, null, "foreign-workspace ticket must NOT be touched");
});
