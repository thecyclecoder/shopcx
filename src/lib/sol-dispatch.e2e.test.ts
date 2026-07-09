/**
 * End-to-end tests — Phase 4 of
 * docs/brain/specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta.md.
 *
 * Exercise the FULL catalog→Direction→apply→guard pipeline (Phases 1-3) as a single composition
 * against an in-memory Supabase stub. Where the per-module tests pin one seam at a time
 * (cx-agent-sdk.test.ts, ticket-directions.test.ts, sol-direction-apply.test.ts,
 * sol-cta-reference-guard.test.ts), THIS suite exercises them together so a regression that
 * subtly breaks the pipeline hand-off (e.g. writeDirection stops accepting `chosen_path='journey'`
 * → applySolDirection quietly falls through to Sonnet) is caught even when each individual seam
 * still looks green.
 *
 * The three Phase-4 verification bullets:
 *  (1) cancel intent + active cancel journey → journey launched with message-aware lead-in.
 *  (2) refund intent → Refund playbook started, not improvised.
 *  (3) 'click below' with no launched mechanism → blocked (assertCtaBackedByLaunch verdict is
 *      not-ok with the cta_tail reason).
 *
 * Run: npx tsx --test src/lib/sol-dispatch.e2e.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { listActionableOutcomes } from "./cx-agent-sdk";
import { writeDirection, getLiveDirection } from "./ticket-directions";
import { applySolDirection } from "./sol-direction-apply";
import { assertCtaBackedByLaunch } from "./sol-cta-reference-guard";

interface Row {
  [k: string]: unknown;
}

interface FakeState {
  journey_definitions: Row[];
  playbooks: Row[];
  workflows: Row[];
  ticket_directions: Row[];
  tickets: Row[];
  journey_sessions: Row[];
  customer_links: Row[];
  customers: Row[];
  orders: Row[];
  subscriptions: Row[];
  products: Row[];
  sonnet_prompts: Row[];
}

function makeAdmin(state: FakeState) {
  let nextDirectionId = 1;
  let nextJourneySessionId = 1;
  function makeBuilder(table: string, rows: Row[]) {
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let insertPayload: Row | null = null;
    const b = {
      select(_cols: string) {
        return b;
      },
      insert(payload: Row) {
        insertPayload = payload;
        return b;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return b;
      },
      is(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return b;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return b;
      },
      gte(col: string, val: unknown) {
        filters.push((r) => (r[col] as string) >= (val as string));
        return b;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderBy = { col, asc: opts?.ascending ?? true };
        return b;
      },
      limit(n: number) {
        limitN = n;
        return b;
      },
      maybeSingle() {
        const match = rows.find((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: match ?? null, error: null });
      },
      single() {
        if (insertPayload) {
          const row: Row = { ...insertPayload };
          if (table === "ticket_directions") {
            row.id = `dir-${nextDirectionId++}`;
            row.superseded_at = null;
            row.authored_at = "2026-07-08T12:00:00Z";
            row.resession_count = row.resession_count ?? 0;
          }
          if (table === "journey_sessions") {
            row.id = `js-${nextJourneySessionId++}`;
            row.created_at = "2026-07-08T12:00:02Z";
          }
          rows.push(row);
          return Promise.resolve({ data: row, error: null });
        }
        const match = rows.find((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: match ?? null, error: null });
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (orderBy) {
          const { col, asc } = orderBy;
          out = [...out].sort((a, b) => {
            const av = a[col] as string;
            const bv = b[col] as string;
            if (av === bv) return 0;
            return (av < bv ? -1 : 1) * (asc ? 1 : -1);
          });
        }
        if (limitN != null) out = out.slice(0, limitN);
        return Promise.resolve({ data: out, error: null }).then(resolve);
      },
    };
    return b;
  }
  return {
    from(table: string) {
      const rows = (state as unknown as Record<string, Row[] | undefined>)[table] ?? [];
      return makeBuilder(table, rows);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const WS = "00000000-0000-0000-0000-0000000000ws";
const TID_CANCEL = "11111111-2222-3333-4444-000000000001";
const TID_REFUND = "11111111-2222-3333-4444-000000000002";
const TID_PROSE = "11111111-2222-3333-4444-000000000003";
const CID = "cust-1";
const TURN_START = "2026-07-08T12:00:00Z";

function baseState(): FakeState {
  return {
    journey_definitions: [
      {
        id: "j-cancel",
        workspace_id: WS,
        slug: "cancel_subscription",
        name: "Cancel Subscription",
        description: "Self-service cancel flow",
        trigger_intent: "cancel_subscription",
        channels: ["email", "chat"],
        priority: 10,
        is_active: true,
      },
    ],
    playbooks: [
      {
        id: "pb-refund",
        workspace_id: WS,
        slug: "refund_with_recovery",
        name: "Refund with Recovery",
        description: "Refund + subscription recovery",
        trigger_intents: ["refund_request", "refund"],
        priority: 8,
        is_active: true,
      },
    ],
    workflows: [],
    ticket_directions: [],
    tickets: [
      { id: TID_CANCEL, workspace_id: WS, active_playbook_id: null },
      { id: TID_REFUND, workspace_id: WS, active_playbook_id: null },
      { id: TID_PROSE, workspace_id: WS, active_playbook_id: null },
    ],
    journey_sessions: [],
    customer_links: [],
    customers: [],
    orders: [],
    subscriptions: [],
    products: [],
    sonnet_prompts: [],
  };
}

/**
 * Verification bullet 1: cancel intent + active cancel journey →
 * (a) catalog lookup returns the journey; (b) Sol writes Direction with chosen_path='journey' +
 * journey_slug; (c) applySolDirection launches the journey with a message-aware lead-in.
 */
test("E2E: cancel intent + active cancel journey → journey launched with message-aware lead-in", async () => {
  const state = baseState();
  const admin = makeAdmin(state);
  const CUSTOMER_MSG = "I want to cancel my ACV subscription, I moved and can't afford it right now";

  // (a) Catalog lookup returns the cancel_subscription journey.
  const catalog = await listActionableOutcomes(admin, WS, "cancel_subscription", { channel: "email" });
  assert.equal(catalog.journeys.length, 1, "catalog surfaces the single active cancel journey");
  assert.equal(catalog.journeys[0].slug, "cancel_subscription");
  assert.equal(catalog.playbooks.length, 0);
  assert.equal(catalog.workflows.length, 0);

  // (b) Sol writes a Direction referencing the catalog row.
  const direction = await writeDirection(admin, {
    workspace_id: WS,
    ticket_id: TID_CANCEL,
    intent: "cancel_subscription",
    context_summary: "customer wants to cancel due to affordability",
    chosen_path: "journey",
    plan: { journey_slug: catalog.journeys[0].slug },
  });
  assert.equal(direction.chosen_path, "journey");
  assert.equal(direction.plan.journey_slug, "cancel_subscription");

  // Direction is now live for this ticket.
  const live = await getLiveDirection(admin, TID_CANCEL, { workspace_id: WS });
  assert.ok(live);
  assert.equal(live!.id, direction.id);

  // (c) Apply the mechanism deterministically.
  const launches: unknown[] = [];
  const leadIns: unknown[] = [];
  const sends: string[] = [];
  const sysNotes: string[] = [];
  const result = await applySolDirection(live!, {
    admin,
    workspaceId: WS,
    ticketId: TID_CANCEL,
    customerId: CID,
    channel: "email",
    message: CUSTOMER_MSG,
    personality: { name: "Sol", tone: "warm" },
    sandbox: false,
    send: async (m) => {
      sends.push(m);
    },
    sysNote: async (m) => {
      sysNotes.push(m);
    },
    generateLeadIn: async (msg, journeyName, ch, p) => {
      leadIns.push({ msg, journeyName, ch, p });
      // Message-aware: echo the customer's phrasing back verbatim so the assertion below can
      // pin that the launched leadIn actually references what they wrote.
      return { leadIn: `About "${msg.slice(0, 60)}" — let me help you.`, ctaText: "Manage Subscription" };
    },
    launchJourney: async (args) => {
      launches.push(args);
      // Simulate the launcher writing a journey_sessions row so Phase 3's guard would see it.
      state.journey_sessions.push({
        id: `js-${state.journey_sessions.length + 1}`,
        workspace_id: WS,
        ticket_id: TID_CANCEL,
        journey_id: args.journeyId,
        created_at: "2026-07-08T12:00:01Z",
      });
      return true;
    },
    startPlaybookFn: async () => {
      throw new Error("playbook path must NOT run on chosen_path='journey'");
    },
    executePlaybookStepFn: async () => {
      throw new Error("playbook step must NOT run on chosen_path='journey'");
    },
  });

  assert.equal(result.applied, true, "the mechanism must be applied");
  assert.equal(result.kind, "journey");
  assert.equal(result.slug, "cancel_subscription");
  assert.equal(result.reason, "journey_launched");

  // launchJourneyForTicket called exactly once with the resolved catalog row.
  assert.equal(launches.length, 1);
  const args = launches[0] as { journeyId: string; journeyName: string; triggerIntent: string; leadIn: string; channel: string };
  assert.equal(args.journeyId, "j-cancel");
  assert.equal(args.journeyName, "Cancel Subscription");
  assert.equal(args.triggerIntent, "cancel_subscription");
  assert.equal(args.channel, "email");

  // Message-aware lead-in: contains the customer's phrasing.
  assert.match(args.leadIn, /cancel/i, "the launched journey's leadIn must reference the customer's message");
  assert.equal(leadIns.length, 1);
  assert.equal((leadIns[0] as { msg: string }).msg, CUSTOMER_MSG);

  // No freeform prose was sent — the CTA is delivered by launchJourneyForTicket.
  assert.equal(sends.length, 0, "no prose reply is sent — the journey CTA is the customer-facing artifact");
});

/**
 * Verification bullet 2: refund intent → Refund playbook is STARTED (not described in prose).
 */
test("E2E: refund intent → Refund playbook started, not improvised", async () => {
  const state = baseState();
  const admin = makeAdmin(state);
  const CUSTOMER_MSG = "the strap on my last order frayed — can I get a refund?";

  const catalog = await listActionableOutcomes(admin, WS, "refund_request");
  assert.equal(catalog.playbooks.length, 1);
  assert.equal(catalog.playbooks[0].slug, "refund_with_recovery");
  assert.equal(catalog.journeys.length, 0);

  const direction = await writeDirection(admin, {
    workspace_id: WS,
    ticket_id: TID_REFUND,
    intent: "refund_request",
    context_summary: "customer wants a refund because strap frayed",
    chosen_path: "playbook",
    plan: { playbook_slug: catalog.playbooks[0].slug, playbook_seed_context: { order_id: "ord-42" } },
  });
  assert.equal(direction.chosen_path, "playbook");
  assert.equal(direction.plan.playbook_slug, "refund_with_recovery");

  const playbookStarts: unknown[] = [];
  const stepCalls: unknown[] = [];
  const sends: string[] = [];
  const sysNotes: string[] = [];

  const result = await applySolDirection(direction, {
    admin,
    workspaceId: WS,
    ticketId: TID_REFUND,
    customerId: CID,
    channel: "email",
    message: CUSTOMER_MSG,
    personality: { name: "Sol", tone: "warm" },
    sandbox: false,
    send: async (m) => {
      sends.push(m);
    },
    sysNote: async (m) => {
      sysNotes.push(m);
    },
    generateLeadIn: async () => ({ leadIn: "", ctaText: "" }),
    launchJourney: async () => {
      throw new Error("journey path must NOT run on chosen_path='playbook' (no self-service rule)");
    },
    startPlaybookFn: async (_admin, ticketId, playbookId, opts) => {
      playbookStarts.push({ ticketId, playbookId, opts });
    },
    executePlaybookStepFn: async (workspaceId, ticketId, msg) => {
      stepCalls.push({ workspaceId, ticketId, msg });
      // Simulate the first step firing an actual refund action + reply. The important thing is
      // that a step ran — NOT a prose "we can look into a refund" reply improvised on top.
      return { action: "reply", response: "Got it — I've started processing the refund on order #ord-42.", systemNote: null };
    },
  });

  assert.equal(result.applied, true);
  assert.equal(result.kind, "playbook");
  assert.equal(result.slug, "refund_with_recovery");
  assert.equal(result.reason, "playbook_started");

  assert.equal(playbookStarts.length, 1, "startPlaybook must run exactly once");
  const started = playbookStarts[0] as { ticketId: string; playbookId: string; opts: { seed_context: Record<string, unknown> } };
  assert.equal(started.ticketId, TID_REFUND);
  assert.equal(started.playbookId, "pb-refund");
  assert.deepEqual(started.opts.seed_context, { order_id: "ord-42" });

  assert.equal(stepCalls.length, 1, "executePlaybookStep must run exactly once for the first step");
  assert.equal((stepCalls[0] as { msg: string }).msg, CUSTOMER_MSG);

  assert.equal(sends.length, 1, "the playbook step's reply is delivered — no orchestrator improv layer");
  assert.match(sends[0], /refund/i);
});

/**
 * Verification bullet 3: 'click below' with no launched mechanism → blocked.
 * This exercises the send-time claim guard end-to-end: a Sonnet-composed ai_response reply
 * saying "click the button below" for a ticket where NO journey was launched this turn is
 * blocked by assertCtaBackedByLaunch with the `blocked_unbacked_claim:cta_tail` reason.
 */
test("E2E: 'click below' with no launched mechanism → blocked with cta_tail claim reason", async () => {
  const state = baseState();
  const admin = makeAdmin(state);
  // Deliberately do NOT insert any journey_sessions row — no journey was launched this turn.

  const REPLY = "Sure — just click the button below to cancel your subscription.";
  const verdict = await assertCtaBackedByLaunch({
    admin,
    workspace_id: WS,
    ticket_id: TID_PROSE,
    message: REPLY,
    turn_started_at: TURN_START,
  });

  assert.equal(verdict.ok, false, "the send must be blocked");
  if (verdict.ok) throw new Error("unreachable");
  assert.match(verdict.reason, /^blocked_unbacked_claim:cta_tail/);
  assert.match(verdict.reason, /click the button below/i);
  assert.equal(verdict.hit.pattern_name, "click_the_button_below");
});

/**
 * Composed sanity check: the SAME reply text sends fine when a journey WAS launched this turn.
 * Rounds out the E2E — a real journey (Phase 2 apply) covers the Phase 3 guard.
 */
test("E2E: same 'click below' reply text with a launched journey → sends normally (guard is backed)", async () => {
  const state = baseState();
  // Simulate Phase 2's launchJourneyForTicket writing the row this turn.
  state.journey_sessions.push({
    id: "js-cancel-1",
    workspace_id: WS,
    ticket_id: TID_PROSE,
    journey_id: "j-cancel",
    created_at: "2026-07-08T12:00:02Z", // after turn_started_at
  });
  const admin = makeAdmin(state);

  const REPLY = "Sure — just click the button below to cancel your subscription.";
  const verdict = await assertCtaBackedByLaunch({
    admin,
    workspace_id: WS,
    ticket_id: TID_PROSE,
    message: REPLY,
    turn_started_at: TURN_START,
  });

  assert.equal(verdict.ok, true, "a real launched journey backs the CTA reference");
});
