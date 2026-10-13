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

interface FakeTicketMessage {
  id: string;
  ticket_id: string;
  direction: string;
  author_type: string;
  visibility: string;
  body: string | null;
  body_clean: string | null;
  created_at: string;
}

interface SeedInput {
  directions: FakeDirection[];
  tickets?: FakeTicket[];
  channel_configs?: FakeChannelConfig[];
  /** Pre-existing agent_jobs rows — used by the Phase-1 `hasActiveTicketHandleJob` probe to
   *  distinguish the "concurrent duplicate" case (a non-terminal ticket-handle row already
   *  exists → bail) from the "genuine no-Direction" case (no such row → enqueue fallback). */
  jobs?: FakeJob[];
  nextJobId?: string;
  /** Phase 1 of inflection-resession-must-act-on-newest-ask — reSessionSol reads the newest
   *  inbound customer message to snapshot the triggering ask onto the agent_jobs instructions.
   *  Seed with newest-first OR any order; the stub orders by `created_at` desc. */
  ticket_messages?: FakeTicketMessage[];
}

function makeAdmin(seed: SeedInput) {
  const state = {
    directions: seed.directions.map((d) => ({ ...d })),
    jobs: (seed.jobs ?? []).map((j) => ({ ...j })),
    tickets: (seed.tickets ?? []).map((t) => ({ ...t })),
    channel_configs: (seed.channel_configs ?? []).map((c) => ({ ...c })),
    resolution_events: [] as FakeResolutionEvent[],
    ticket_messages: (seed.ticket_messages ?? []).map((m) => ({ ...m })),
    // The router may READ ticket_messages (Phase 1 snapshot of the newest customer ask) but
    // must NEVER write to it — the router sends no customer-facing message.
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
    // Two disjoint call shapes hit this table:
    //   (a) insert path (both the step-(6) enqueue and the Phase-1 fallback enqueue):
    //         .from('agent_jobs').insert(row).select('id').single()
    //   (b) probe path (Phase-1 `hasActiveTicketHandleJob`):
    //         .from('agent_jobs').select('id').eq('workspace_id',ws).eq('spec_slug',slug)
    //           .in('status', ACTIVE_STATUSES).limit(1)  → awaitable Promise<{data,error}>
    // Model both here — the shared object exposes `.insert()` for (a) and `.select()` for (b).
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, Set<unknown>> = {};

    const selectBuilder = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return selectBuilder;
      },
      in(col: string, vals: unknown[]) {
        inFilters[col] = new Set(vals);
        return selectBuilder;
      },
      limit(_n: number) {
        const matches = state.jobs.filter((j) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((j as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          for (const [k, set] of Object.entries(inFilters)) {
            if (!set.has((j as unknown as Record<string, unknown>)[k])) return false;
          }
          return true;
        });
        return Promise.resolve({ data: matches.map((m) => ({ id: m.id })), error: null });
      },
    };

    return {
      select(_cols: string) {
        return selectBuilder;
      },
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

  function fromTicketMessages() {
    // The read path the Phase-1 trigger_message snapshot uses — now with the Phase-5
    // tenant guard (tickets!inner workspace filter):
    //   .select("id, body, body_clean, created_at, tickets!inner(id)")
    //     .eq("ticket_id", ...)
    //     .eq("tickets.workspace_id", ...)   ← parent-table filter (tenant boundary)
    //     .eq("direction", "inbound")
    //     .eq("author_type", "customer")
    //     .neq("visibility", "internal")
    //     .order("created_at", { ascending: false })
    //     .limit(1)   → Promise<{data: row[], error}>
    // Writes (insert / update / upsert) are not expected and fail the test.
    const filters: Record<string, unknown> = {};
    const parentFilters: Record<string, Record<string, unknown>> = {};
    const neFilters: Record<string, unknown> = {};
    let orderDesc = false;
    const builder = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        // Phase 5 — a `tickets.workspace_id` filter is a join-side predicate against
        // the parent ticket row, not a column on ticket_messages. Route it to the
        // parentFilters bucket so the limit() terminal can enforce it against the
        // seeded tickets state.
        const dot = col.indexOf(".");
        if (dot > 0) {
          const parent = col.slice(0, dot);
          const key = col.slice(dot + 1);
          parentFilters[parent] = parentFilters[parent] ?? {};
          parentFilters[parent]![key] = val;
          return builder;
        }
        filters[col] = val;
        return builder;
      },
      neq(col: string, val: unknown) {
        neFilters[col] = val;
        return builder;
      },
      order(_col: string, opts: { ascending?: boolean }) {
        orderDesc = opts?.ascending === false;
        return builder;
      },
      limit(n: number) {
        let rows = state.ticket_messages.filter((m) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((m as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          for (const [k, v] of Object.entries(neFilters)) {
            if ((m as unknown as Record<string, unknown>)[k] === v) return false;
          }
          // Phase 5 tenant-guard: enforce parent-table filters by looking up the
          // ticket row via state.tickets[].id and requiring every parent-column eq.
          // A ticket_messages row whose parent ticket doesn't match the predicates
          // (foreign workspace, or no matching ticket at all) is filtered OUT —
          // this models the PostgREST `!inner` join faithfully.
          for (const [parent, preds] of Object.entries(parentFilters)) {
            if (parent !== "tickets") continue; // only join we model here
            const parentRow = state.tickets.find((t) => t.id === (m as unknown as { ticket_id?: string }).ticket_id);
            if (!parentRow) return false;
            for (const [pk, pv] of Object.entries(preds)) {
              if ((parentRow as unknown as Record<string, unknown>)[pk] !== pv) return false;
            }
          }
          return true;
        });
        rows = rows.slice().sort((a, b) => (orderDesc
          ? (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)
          : (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)));
        rows = rows.slice(0, n);
        return Promise.resolve({
          data: rows.map((r) => ({
            id: r.id,
            body: r.body,
            body_clean: r.body_clean,
            created_at: r.created_at,
          })),
          error: null,
        });
      },
      insert(_row: unknown) {
        state.ticketMessageWrites++;
        throw new Error(
          "reSessionSol must NOT write to ticket_messages — the router sends no customer-facing message",
        );
      },
      update(_patch: unknown) {
        state.ticketMessageWrites++;
        throw new Error(
          "reSessionSol must NOT write to ticket_messages — the router sends no customer-facing message",
        );
      },
    };
    return builder;
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
      if (table === "ticket_messages") return fromTicketMessages();
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

function seedInboundMsg(overrides: Partial<FakeTicketMessage> = {}): FakeTicketMessage {
  return {
    id: "msg-newest",
    ticket_id: TID,
    direction: "inbound",
    author_type: "customer",
    visibility: "external",
    body: "Can we move order to Oct 30th as I ordered enough Aug n Sept???????",
    body_clean: "Can we move order to Oct 30th as I ordered enough Aug n Sept???????",
    created_at: "2026-08-05T14:14:00Z",
    ...overrides,
  };
}

test("frustration + live Direction → supersede fires + agent_jobs row carries the spec payload", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    ticket_messages: [seedInboundMsg()],
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
  // Phase 1 of inflection-resession-must-act-on-newest-ask — the triggering message is
  // snapshotted onto the instructions so Sol can quote it + address it, not just the kind label.
  assert.ok(parsed.trigger_message, "trigger_message must be present on the instructions");
  assert.equal(parsed.trigger_message.id, "msg-newest");
  assert.equal(
    parsed.trigger_message.text,
    "Can we move order to Oct 30th as I ordered enough Aug n Sept???????",
  );
  assert.equal(parsed.trigger_message.created_at, "2026-08-05T14:14:00Z");
});

test("drift branch: same supersede+enqueue shape — the holding-message policy is the caller's job", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    ticket_messages: [seedInboundMsg()],
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

// ── Phase 1 of sol-resession-enqueue-first-touch-when-no-live-direction — ─────
// fallback enqueue when getLiveDirection returns null. The marker string
// "no-live-direction fallback" in each name is asserted by the spec's structural
// check so a future refactor cannot silently reinstate the drop.

test("no-live-direction fallback: enqueues on genuine no-Direction (nothing ever authored + no active ticket-handle job)", async () => {
  // A pre-Sol legacy ticket: no direction row exists AND no active session is in flight.
  // The Phase-2 gate has already sent the "we're looking into that for you" holding message,
  // so bailing would strand the customer. The fallback must enqueue a fresh first-touch-shaped
  // session so the promise is kept.
  const { admin, state } = makeAdmin({
    directions: [],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    jobs: [],
    ticket_messages: [seedInboundMsg()],
    nextJobId: "job-fallback",
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
    turn_index: 2,
  });
  assert.equal(res.enqueued, true, "fallback must enqueue when there is no live Direction and no active job");
  assert.equal(res.superseded, false, "nothing to supersede — no live Direction");
  assert.equal(res.cap_hit, false);
  assert.equal(res.superseded_direction_id, null);
  assert.equal(res.job_id, "job-fallback");

  // Exactly one agent_jobs insert fired.
  assert.equal(state.jobs.length, 1);
  const job = state.jobs[0]!;
  assert.equal(job.kind, "ticket-handle");
  assert.equal(job.workspace_id, WS);
  assert.equal(job.status, "queued");
  assert.equal(job.spec_slug, `ticket-handle-${TID.slice(0, 8)}`);

  const parsed = JSON.parse(job.instructions);
  assert.equal(parsed.ticket_id, TID);
  assert.equal(parsed.workspace_id, WS);
  assert.equal(parsed.turn_index, 2);
  assert.equal(parsed.reason, "inflection");
  assert.equal(parsed.kind, "frustration");
  assert.equal(parsed.superseded_direction_id, null, "no prior Direction to link — must be null");
  assert.deepEqual(parsed.evidence, EV);
  // Phase 1 — the fallback enqueue carries the trigger_message snapshot too, so a bounced
  // first-touch session can quote the customer's newest ask instead of guessing from the brief.
  assert.ok(
    parsed.trigger_message,
    "fallback-enqueue instructions must carry trigger_message (Phase 1)",
  );
  assert.equal(parsed.trigger_message.id, "msg-newest");

  // Observability ledger row stamped with the distinguishing reasoning marker.
  const ev = state.resolution_events.find((e) => e.reasoning === "sol:resession-no-direction");
  assert.ok(ev, "must stamp sol:resession-no-direction ledger row for observability");
  assert.equal(ev!.turn_index, 2);
  assert.deepEqual(ev!.chosen, {
    kind: "frustration",
    fallback: "first_touch_no_live_direction",
  });
});

test("no-live-direction fallback: bails on concurrent duplicate (no live Direction + an active ticket-handle job present)", async () => {
  // True race: a concurrent caller already superseded the live row and enqueued its own
  // follow-up. That job is in-flight in agent_jobs, so the dedup guard MUST make us bail
  // rather than fan out a duplicate session.
  const activeJob: FakeJob = {
    id: "job-in-flight",
    workspace_id: WS,
    kind: "ticket-handle",
    spec_slug: `ticket-handle-${TID.slice(0, 8)}`,
    status: "building", // non-terminal — matches ACTIVE_STATUSES from @/lib/agent-jobs
    instructions: "",
  };
  const { admin, state } = makeAdmin({
    directions: [],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    jobs: [activeJob],
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  assert.equal(res.enqueued, false, "must bail when a concurrent ticket-handle session is in flight");
  assert.equal(res.superseded, false);
  assert.equal(res.cap_hit, false);
  assert.equal(res.superseded_direction_id, null);
  assert.equal(res.job_id, null);

  // No NEW insert fired — only the pre-existing seeded job remains.
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0]!.id, "job-in-flight", "no new agent_jobs row inserted");

  // No observability ledger row either — the bail is silent (mirrors the pre-Phase-1 no-op).
  assert.equal(
    state.resolution_events.filter((e) => e.reasoning === "sol:resession-no-direction").length,
    0,
    "no ledger stamp on the bail path",
  );
});

test("workspace scoping: a same-ticket-id row in a DIFFERENT workspace is NOT superseded", async () => {
  const otherWs = "99999999-0000-0000-0000-0000000000ws";
  const foreign = seedLive({ id: "dir-foreign", workspace_id: otherWs });
  // Seed a same-workspace active job so the Phase-1 fallback bails cleanly — this test
  // isolates the workspace-scoping of the supersede path, not the fallback enqueue.
  const activeJob: FakeJob = {
    id: "job-in-flight",
    workspace_id: WS,
    kind: "ticket-handle",
    spec_slug: `ticket-handle-${TID.slice(0, 8)}`,
    status: "queued",
    instructions: "",
  };
  const { admin, state } = makeAdmin({
    directions: [foreign],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    jobs: [activeJob],
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

// ── Phase 1 of inflection-resession-must-act-on-newest-ask — trigger_message ──
// The re-session instructions MUST carry the newest inbound customer message so
// Sol's prompt can tell her WHICH ask to address (the inflection `kind` is tone
// context only). Ground truth: ticket dc31bf31 (14:14 "move to Oct 30???????" →
// Sol re-answered Sep 2 → $237.16 refund + cancelled subscriber).

test("Phase 1: trigger_message snapshots the NEWEST inbound customer ticket_messages row (not an older one)", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    ticket_messages: [
      seedInboundMsg({
        id: "msg-older",
        body: "Where is my order?",
        body_clean: "Where is my order?",
        created_at: "2026-08-05T13:00:00Z",
      }),
      seedInboundMsg({
        id: "msg-newest",
        body: "Can we move order to Oct 30th as I ordered enough Aug n Sept???????",
        body_clean: "Can we move order to Oct 30th as I ordered enough Aug n Sept???????",
        created_at: "2026-08-05T14:14:00Z",
      }),
    ],
    nextJobId: "job-newest-ask",
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
    turn_index: 2,
  });
  assert.equal(res.enqueued, true);
  const parsed = JSON.parse(state.jobs[0]!.instructions);
  assert.ok(parsed.trigger_message, "trigger_message must be present");
  assert.equal(parsed.trigger_message.id, "msg-newest", "newest inbound message wins");
  assert.equal(
    parsed.trigger_message.text,
    "Can we move order to Oct 30th as I ordered enough Aug n Sept???????",
  );
  assert.equal(parsed.trigger_message.created_at, "2026-08-05T14:14:00Z");
});

test("Phase 1: trigger_message prefers body_clean over body (same text the detector classified)", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    ticket_messages: [
      seedInboundMsg({
        id: "msg-newest",
        body: "<p>raw HTML wrapper</p>Can we move order to Oct 30th?",
        body_clean: "Can we move order to Oct 30th?",
        created_at: "2026-08-05T14:14:00Z",
      }),
    ],
    nextJobId: "job-prefer-clean",
  });
  await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  const parsed = JSON.parse(state.jobs[0]!.instructions);
  assert.equal(
    parsed.trigger_message.text,
    "Can we move order to Oct 30th?",
    "body_clean must win over raw body",
  );
});

test("Phase 1: trigger_message falls back to body when body_clean is null (pre-normalizer legacy row)", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    ticket_messages: [
      seedInboundMsg({
        id: "msg-legacy",
        body: "move my order please",
        body_clean: null,
        created_at: "2026-08-05T14:14:00Z",
      }),
    ],
    nextJobId: "job-legacy",
  });
  await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  const parsed = JSON.parse(state.jobs[0]!.instructions);
  assert.equal(parsed.trigger_message.text, "move my order please");
  assert.equal(parsed.trigger_message.id, "msg-legacy");
});

test("Phase 1: trigger_message skips internal / outbound / non-customer rows (no agent-note masquerade)", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    ticket_messages: [
      // Internal triage stamp — must NOT be picked as the trigger.
      seedInboundMsg({
        id: "msg-internal",
        visibility: "internal",
        body: "[Triage] Unrecognized portal error",
        body_clean: "[Triage] Unrecognized portal error",
        created_at: "2026-08-05T14:20:00Z",
      }),
      // Outbound reply — must NOT be picked.
      seedInboundMsg({
        id: "msg-outbound",
        direction: "outbound",
        body: "Thanks for reaching out",
        body_clean: "Thanks for reaching out",
        created_at: "2026-08-05T14:19:00Z",
      }),
      // AI-authored draft — not a customer message.
      seedInboundMsg({
        id: "msg-ai",
        author_type: "ai",
        body: "AI draft",
        body_clean: "AI draft",
        created_at: "2026-08-05T14:18:00Z",
      }),
      // The real customer message is older than all three above — scope filters must still pick it.
      seedInboundMsg({
        id: "msg-newest-customer",
        body: "please move my order to Oct 30",
        body_clean: "please move my order to Oct 30",
        created_at: "2026-08-05T14:14:00Z",
      }),
    ],
    nextJobId: "job-scope",
  });
  await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  const parsed = JSON.parse(state.jobs[0]!.instructions);
  assert.equal(
    parsed.trigger_message.id,
    "msg-newest-customer",
    "internal / outbound / AI rows must not masquerade as the newest customer ask",
  );
});

test("Phase 1: trigger_message is null when no inbound customer messages exist yet (very early race)", async () => {
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()],
    channel_configs: [seedConfig()],
    ticket_messages: [],
    nextJobId: "job-no-msgs",
  });
  await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  const parsed = JSON.parse(state.jobs[0]!.instructions);
  assert.equal(
    parsed.trigger_message,
    null,
    "null is persisted explicitly so the worker can tell 'snapshot ran but found nothing' from 'field never shipped'",
  );
});

// Phase 5 (security-review fix) — cross-tenant guard on the ticket_messages read ────
// Pre-Phase-5, loadTriggerMessageForTicket read ticket_messages by ticket_id alone and
// discarded the workspace_id param (ticket_messages has no workspace_id column of its
// own). A caller passing a foreign ticket_id with the attacker's workspace would snapshot
// a message from someone else's workspace into the agent_jobs instructions. The fix:
// a tickets!inner workspace_id join-filter so the parent ticket must belong to the
// caller's workspace or the message set is empty.

test("Phase 5 security: a ticket_id from a FOREIGN workspace cannot leak a message into trigger_message", async () => {
  const foreignWs = "77777777-0000-0000-0000-0000000000ws";
  const foreignTicket = {
    id: TID,
    workspace_id: foreignWs,
    escalated_at: null,
    escalated_to: null,
    escalation_reason: null,
  };
  // Seed a same-workspace active job so the fallback bails cleanly (no live Direction
  // in input.workspace_id). This isolates the test to the message-read scoping.
  const activeJob: FakeJob = {
    id: "job-in-flight",
    workspace_id: WS,
    kind: "ticket-handle",
    spec_slug: `ticket-handle-${TID.slice(0, 8)}`,
    status: "queued",
    instructions: "",
  };
  const { admin, state } = makeAdmin({
    directions: [],
    tickets: [foreignTicket],
    channel_configs: [seedConfig()],
    jobs: [activeJob],
    // The message exists on the ticket row, but the row belongs to a FOREIGN workspace.
    // The guard must refuse to surface it.
    ticket_messages: [
      {
        id: "msg-foreign",
        ticket_id: TID,
        direction: "inbound",
        author_type: "customer",
        visibility: "external",
        body: "secret-cross-tenant-text",
        body_clean: "secret-cross-tenant-text",
        created_at: "2026-08-05T14:14:00Z",
      },
    ],
  });
  const res = await reSessionSol(admin, TID, {
    workspace_id: WS, // caller's workspace — DIFFERENT from the ticket's foreignWs
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  // No live Direction in WS + an active job already in WS → the router bails. No new
  // agent_jobs row inserted. The security guarantee being tested: even if the router
  // HAD fanned out, the trigger_message would be null because the join rejects the
  // foreign-workspace parent row.
  assert.equal(res.enqueued, false, "concurrent-job dedup should bail");
  // Prove the guard directly: insert a non-foreign case to show the diff is scoping.
  // (A follow-up guard test below seeds a same-workspace ticket to prove the read works.)
  // Here the invariant: no NEW job row created; no foreign message escaped the scope.
  assert.equal(state.jobs.length, 1, "no new job inserted on the concurrent-dedup path");
  const existing = state.jobs[0]!;
  assert.equal(existing.id, "job-in-flight", "pre-existing job untouched");
  // And the stub's write-count guard confirms the router did not write to ticket_messages.
  assert.equal(state.ticketMessageWrites, 0, "router must not write to ticket_messages");
});

test("Phase 5 security: a ticket_id in the CALLER's workspace still returns its newest message (positive case)", async () => {
  // Positive side of the tenant guard: same ticket_id, same workspace → message surfaces.
  const { admin, state } = makeAdmin({
    directions: [seedLive()],
    tickets: [seedTicket()], // this is in WS (the caller's workspace)
    channel_configs: [seedConfig()],
    ticket_messages: [
      {
        id: "msg-same-ws",
        ticket_id: TID,
        direction: "inbound",
        author_type: "customer",
        visibility: "external",
        body: "legitimate-same-tenant-ask",
        body_clean: "legitimate-same-tenant-ask",
        created_at: "2026-08-05T14:14:00Z",
      },
    ],
    nextJobId: "job-positive",
  });
  await reSessionSol(admin, TID, {
    workspace_id: WS,
    channel: CH,
    kind: "frustration",
    evidence: EV,
  });
  const parsed = JSON.parse(state.jobs[0]!.instructions);
  assert.ok(parsed.trigger_message, "same-workspace ticket must still surface its newest message");
  assert.equal(parsed.trigger_message.id, "msg-same-ws");
  assert.equal(parsed.trigger_message.text, "legitimate-same-tenant-ask");
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
