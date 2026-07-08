/**
 * Unit tests for applyInflectionGate — the composed helper that unified-ticket-handler.ts
 * calls between the inbound-message handling and the playbook/Sonnet dispatch. This is the
 * Phase-4 (Fix 1) wire-in — the failing pre-merge spec-test checks pinned every one of these
 * observable behaviors:
 *   - frustration inbound → NO customer-facing reply drafted/sent (0 sends beyond the
 *     holding message), ticket_resolution_events row carries reasoning='sol:inflection-frustration'.
 *   - drift inbound → same supersede + agent_jobs insert AND NO holding-message send.
 *   - playbook-active + frustration → gate still fires (playbook execution halted).
 *   - live-Direction frustration → superseded_at stamped + agent_jobs kind='ticket-handle'
 *     with payload.reason='inflection' + holding-message ticket_messages row (default cfg).
 *   - benign inbound → gate returns 'none' + zero side effects (fall-through to Sonnet).
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/inflection-detector.applyGate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyInflectionGate, type HaikuVerdict } from "./inflection-detector";

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

interface FakeTicket {
  id: string;
  workspace_id: string;
  active_playbook_id: string | null;
  playbook_exceptions_used: number | null;
  updated_at: string | null;
}

interface FakeResolutionRow {
  workspace_id: string;
  ticket_id: string;
  turn_index: number;
  reasoning: string | null;
  chosen: unknown;
}

interface FakeJob {
  id: string;
  kind: string;
  workspace_id: string;
  spec_slug: string;
  status: string;
  instructions: string;
}

function makeAdmin(seed: {
  directions?: FakeDirection[];
  tickets?: FakeTicket[];
  resolutionRows?: FakeResolutionRow[];
  nextJobId?: string;
}) {
  const state = {
    directions: (seed.directions ?? []).map((d) => ({ ...d })),
    tickets: (seed.tickets ?? []).map((t) => ({ ...t })),
    resolutionRows: (seed.resolutionRows ?? []).map((r) => ({ ...r })),
    jobs: [] as FakeJob[],
  };
  let nextJobId = seed.nextJobId ?? "job-1";

  function fromTicketDirections() {
    // Two shapes used against ticket_directions:
    //  (a) getLiveDirection: .select(COLS).eq("ticket_id",…).is("superseded_at",null).eq("workspace_id",…).maybeSingle()
    //  (b) superseDirection: .update(…).eq("ticket_id",…).is("superseded_at",null).eq("workspace_id",…).select(COLS)
    let mode: "select" | "update" = "select";
    let onlyLive = false;
    const filters: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const builder = {
      select(_cols?: string) {
        if (mode === "update") {
          const rows = state.directions.filter((d) => {
            if (onlyLive && d.superseded_at !== null) return false;
            for (const [k, v] of Object.entries(filters)) if ((d as unknown as Record<string, unknown>)[k] !== v) return false;
            return true;
          });
          if (patch) for (const m of rows) Object.assign(m, patch);
          return Promise.resolve({ data: rows, error: null });
        }
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
        const rows = state.directions.filter((d) => {
          if (onlyLive && d.superseded_at !== null) return false;
          for (const [k, v] of Object.entries(filters)) if ((d as unknown as Record<string, unknown>)[k] !== v) return false;
          return true;
        });
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
    };
    return builder;
  }

  function fromTicketResolutionEvents() {
    // Shapes used:
    //  (a) recent turns select: .select("reasoning, turn_index").eq(…).eq(…).order(…).limit(3) — awaited directly (thenable)
    //  (b) staging insert: .insert(row) — awaited directly
    const filters: Record<string, unknown> = {};
    let orderDesc = false;
    let limit = Infinity;
    const builder: Record<string, unknown> = {
      select(_cols?: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      order(_col: string, o: { ascending: boolean }) {
        orderDesc = !o.ascending;
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      then(cb: (r: { data: FakeResolutionRow[]; error: null }) => unknown) {
        const rows = state.resolutionRows.filter((r) => {
          for (const [k, v] of Object.entries(filters)) if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
          return true;
        });
        rows.sort((a, b) => (orderDesc ? b.turn_index - a.turn_index : a.turn_index - b.turn_index));
        return Promise.resolve({ data: rows.slice(0, limit), error: null }).then(cb);
      },
      insert(row: Record<string, unknown>) {
        state.resolutionRows.push({
          workspace_id: String(row.workspace_id),
          ticket_id: String(row.ticket_id),
          turn_index: Number(row.turn_index),
          reasoning: (row.reasoning as string | null) ?? null,
          chosen: row.chosen,
        });
        return Promise.resolve({ data: null, error: null });
      },
    };
    return builder;
  }

  function fromTickets() {
    // .select(…).eq(…).eq(…).maybeSingle()
    const filters: Record<string, unknown> = {};
    const builder = {
      select(_cols: string) { return builder; },
      eq(col: string, val: unknown) { filters[col] = val; return builder; },
      maybeSingle() {
        const row = state.tickets.find((t) => {
          for (const [k, v] of Object.entries(filters)) if ((t as unknown as Record<string, unknown>)[k] !== v) return false;
          return true;
        }) ?? null;
        return Promise.resolve({ data: row, error: null });
      },
    };
    return builder;
  }

  function fromAgentJobs() {
    return {
      insert(row: Record<string, unknown>) {
        const job: FakeJob = {
          id: nextJobId,
          kind: String(row.kind),
          workspace_id: String(row.workspace_id),
          spec_slug: String(row.spec_slug),
          status: String(row.status),
          instructions: String(row.instructions ?? ""),
        };
        state.jobs.push(job);
        return {
          select(_c: string) {
            return { single() { return Promise.resolve({ data: { id: job.id }, error: null }); } };
          },
        };
      },
    };
  }

  const admin = {
    from(table: string) {
      if (table === "ticket_directions") return fromTicketDirections();
      if (table === "ticket_resolution_events") return fromTicketResolutionEvents();
      if (table === "tickets") return fromTickets();
      if (table === "agent_jobs") return fromAgentJobs();
      if (table === "ticket_messages") {
        throw new Error(
          "applyInflectionGate must never write to ticket_messages — the router doesn't send",
        );
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  return { admin, state };
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
    authored_at: "2026-07-01T00:00:00Z",
    superseded_at: null,
    ...overrides,
  };
}

function seedTicket(overrides: Partial<FakeTicket> = {}): FakeTicket {
  return {
    id: TID,
    workspace_id: WS,
    active_playbook_id: null,
    playbook_exceptions_used: 0,
    updated_at: "2026-07-08T00:00:00Z",
    ...overrides,
  };
}

test("check #1 + #4 + #6: frustration cue → sol:inflection-frustration ledger row + supersede + enqueue + holding message", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    nextJobId: "job-frust",
  });
  const sends: Array<{ channel: string; body: string }> = [];
  const res = await applyInflectionGate({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    channel: "email",
    newestMessage: "refund me now, this is ridiculous",
    aiTurnLimit: 6,
    solFrustrationHoldingMessageEnabled: true,
    sendHoldingMessage: async (channel, body) => {
      sends.push({ channel, body });
    },
  });
  assert.equal(res.kind, "frustration");
  assert.equal(res.holdingMessageSent, true);
  assert.equal(res.reSession?.superseded, true);
  assert.equal(res.reSession?.enqueued, true);
  // Direction was superseded.
  assert.notEqual(state.directions[0]!.superseded_at, null);
  // Ledger row present with the exact spec-verification prefix.
  assert.equal(state.resolutionRows.length, 1);
  assert.equal(state.resolutionRows[0]!.reasoning, "sol:inflection-frustration");
  // Evidence populated (spec Phase 3 bullet 4).
  assert.ok(state.resolutionRows[0]!.chosen, "evidence must be persisted");
  // agent_jobs row with payload.reason='inflection' payload.kind='frustration'.
  assert.equal(state.jobs.length, 1);
  const payload = JSON.parse(state.jobs[0]!.instructions);
  assert.equal(payload.reason, "inflection");
  assert.equal(payload.kind, "frustration");
  assert.equal(payload.superseded_direction_id, "dir-live");
  // Holding message sent exactly once.
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.channel, "email");
  assert.match(sends[0]!.body, /looking into/i);
});

test("check #5: drift → superseded + agent_jobs insert but NO holding-message send", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    nextJobId: "job-drift",
    // Prime the turn index at 4 so this turn is 5 (>= 0.8 * ai_turn_limit=6 → turn_limit_approach).
    // Reasoning is deliberately generic — no overlap with the Direction.intent tokens, so the
    // keyword-mismatch signal also fires on a topic pivot below (two Stage-1 signals → definite drift).
    resolutionRows: [
      { workspace_id: WS, ticket_id: TID, turn_index: 4, reasoning: "acknowledged and awaiting reply", chosen: null },
    ],
  });
  const sends: Array<{ channel: string; body: string }> = [];
  const res = await applyInflectionGate({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    channel: "email",
    // Topic pivot away from "refund shipping delay" — none of the intent tokens appear here
    // OR in the prior turn's reasoning, so mismatch = 1.0 → drift_keyword_mismatch AND
    // turn_limit_approach both fire → definite drift.
    newestMessage: "actually change my flavor to strawberry",
    aiTurnLimit: 6,
    solFrustrationHoldingMessageEnabled: true,
    sendHoldingMessage: async (channel, body) => { sends.push({ channel, body }); },
  });
  assert.equal(res.kind, "drift");
  assert.equal(res.holdingMessageSent, false, "drift MUST NOT send a holding message");
  assert.equal(res.reSession?.superseded, true);
  assert.equal(res.reSession?.enqueued, true);
  assert.equal(sends.length, 0, "no send callback invocation on drift");
  // Ledger + job carry the drift kind.
  assert.equal(state.resolutionRows.at(-1)!.reasoning, "sol:inflection-drift");
  assert.equal(JSON.parse(state.jobs[0]!.instructions).kind, "drift");
});

test("check #3: playbook-active + frustration → gate fires (playbook execution halted)", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive({ chosen_path: "playbook" })],
    tickets: [seedTicket({ active_playbook_id: "pb-1" })],
    nextJobId: "job-mid-pb",
  });
  const sends: Array<{ channel: string; body: string }> = [];
  const res = await applyInflectionGate({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    channel: "email",
    newestMessage: "refund me now",
    aiTurnLimit: 6,
    solFrustrationHoldingMessageEnabled: true,
    sendHoldingMessage: async (channel, body) => { sends.push({ channel, body }); },
  });
  assert.equal(res.kind, "frustration", "mid-playbook frustration cue must still bounce");
  assert.equal(res.reSession?.superseded, true);
  assert.equal(res.reSession?.enqueued, true);
  assert.equal(sends.length, 1);
});

test("benign message → 'none' + zero side effects (fall-through to Sonnet)", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
  });
  const sends: Array<{ channel: string; body: string }> = [];
  const res = await applyInflectionGate({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    channel: "email",
    newestMessage: "thanks for the tracking update, appreciate the fast shipping refund handling",
    aiTurnLimit: 6,
    solFrustrationHoldingMessageEnabled: true,
    sendHoldingMessage: async (channel, body) => { sends.push({ channel, body }); },
  });
  assert.equal(res.kind, "none");
  assert.equal(res.reSession, null);
  assert.equal(res.holdingMessageSent, false);
  assert.equal(res.ledgerStaged, false);
  assert.equal(state.resolutionRows.length, 0, "no ledger row on 'none'");
  assert.equal(state.jobs.length, 0, "no re-session on 'none'");
  assert.equal(state.directions[0]!.superseded_at, null, "Direction untouched on 'none'");
  assert.equal(sends.length, 0);
});

test("frustration with holding-message feature-flag OFF → still bounces but no holding message", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    nextJobId: "job-silent-frust",
  });
  const sends: Array<{ channel: string; body: string }> = [];
  const res = await applyInflectionGate({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    channel: "email",
    newestMessage: "refund me now",
    aiTurnLimit: 6,
    solFrustrationHoldingMessageEnabled: false, // workspace turned it off
    sendHoldingMessage: async (channel, body) => { sends.push({ channel, body }); },
  });
  assert.equal(res.kind, "frustration");
  assert.equal(res.holdingMessageSent, false, "flag OFF must suppress the holding message");
  assert.equal(res.reSession?.superseded, true, "bounce still fires — holding message is optional");
  assert.equal(sends.length, 0);
  assert.equal(state.jobs.length, 1, "re-session enqueue still happens");
});

test("no live Direction on the ticket → 'none' fallback (no bounce, no Sonnet-cost skip)", async () => {
  // Ticket exists but Sol never authored a Direction. The gate should be a no-op so the
  // existing Sonnet path runs — Phase-2's fresh-Direction Haiku route depends on this.
  const { admin, state } = makeAdmin({
    directions: [],
    tickets: [seedTicket()],
  });
  const sends: Array<{ channel: string; body: string }> = [];
  const res = await applyInflectionGate({
    admin,
    workspace_id: WS,
    ticket_id: TID,
    channel: "email",
    // Ambiguous single-signal (would escalate to Haiku) — but with no Direction, detector
    // collapses to 'none' without spending a Haiku call.
    newestMessage: "can you swap my flavor",
    aiTurnLimit: 6,
    solFrustrationHoldingMessageEnabled: true,
    sendHoldingMessage: async (channel, body) => { sends.push({ channel, body }); },
    haiku: async (): Promise<HaikuVerdict | null> => {
      assert.fail("Haiku must not be called when no Direction is present");
    },
  });
  assert.equal(res.kind, "none");
  assert.equal(state.jobs.length, 0);
  assert.equal(sends.length, 0);
});
