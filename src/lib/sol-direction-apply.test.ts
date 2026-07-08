/**
 * Unit tests for sol-direction-apply — Phase 2 of
 * docs/brain/specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta.md.
 *
 * Pin the four Phase-2 verification bullets:
 *  (1) A cancel ticket with an active cancel journey results in launchJourneyForTicket being
 *      called (journey_deliveries row + CTA in the sent message), NOT a prose 'click below' reply.
 *  (2) The launched journey's lead-in references the customer's specific incoming message.
 *  (3) A prompt rule that forbids acting-for-the-customer routes to the self-service journey and
 *      no direct-cancel mutation is dispatched.
 *  (4) A playbook-matched intent starts the playbook rather than describing it.
 *
 * Runs against an in-memory Supabase stub + injected effect functions so the branch decisions are
 * exercised deterministically — same pattern as ticket-directions.test.ts. Run:
 *   npx tsx --test src/lib/sol-direction-apply.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applySolDirection, isSelfServiceOnlyIntent } from "./sol-direction-apply";
import type { TicketDirection } from "./ticket-directions";

interface Row {
  [k: string]: unknown;
}

interface FakeState {
  journey_definitions: Row[];
  playbooks: Row[];
  tickets: Row[];
}

function makeAdmin(state: FakeState) {
  function makeBuilder(rows: Row[]) {
    const filters: Array<(r: Row) => boolean> = [];
    const b = {
      select(_cols: string) {
        return b;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return b;
      },
      maybeSingle() {
        const match = rows.find((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: match ?? null, error: null });
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        const out = rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: out, error: null }).then(resolve);
      },
    };
    return b;
  }
  return {
    from(table: string) {
      const rows = (state as unknown as Record<string, Row[] | undefined>)[table] ?? [];
      return makeBuilder(rows);
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const WS = "00000000-0000-0000-0000-0000000000ws";
const TID = "11111111-2222-3333-4444-555555555555";
const CID = "cust-1";

function makeDirection(overrides: Partial<TicketDirection> = {}): TicketDirection {
  return {
    id: "dir-1",
    workspace_id: WS,
    ticket_id: TID,
    intent: "cancel_subscription",
    context_summary: "customer wants to cancel",
    chosen_path: "journey",
    plan: { journey_slug: "cancel_subscription" },
    guardrails: {},
    authored_by: "sol_box_session",
    authored_at: "2026-07-08T00:00:00Z",
    superseded_at: null,
    resession_count: 0,
    ...overrides,
  };
}

function baseState(): FakeState {
  return {
    journey_definitions: [
      {
        id: "j-cancel",
        workspace_id: WS,
        slug: "cancel_subscription",
        name: "Cancel Subscription",
        trigger_intent: "cancel_subscription",
        is_active: true,
      },
    ],
    playbooks: [
      {
        id: "pb-refund",
        workspace_id: WS,
        slug: "refund_with_recovery",
        name: "Refund with Recovery",
        is_active: true,
      },
    ],
    tickets: [{ id: TID, workspace_id: WS, active_playbook_id: null }],
  };
}

function makeDeps(state: FakeState, overrides?: Record<string, unknown>) {
  const admin = makeAdmin(state);
  const sent: string[] = [];
  const sysNotes: string[] = [];
  const journeyLaunches: unknown[] = [];
  const playbookStarts: unknown[] = [];
  const stepCalls: unknown[] = [];
  const leadInCalls: unknown[] = [];

  const deps = {
    admin,
    workspaceId: WS,
    ticketId: TID,
    customerId: CID,
    channel: "email",
    message: "I want to cancel my ACV gummies please",
    personality: { name: "Sol", tone: "warm" },
    sandbox: false,
    send: async (m: string) => {
      sent.push(m);
    },
    sysNote: async (m: string) => {
      sysNotes.push(m);
    },
    generateLeadIn: async (msg: string, journeyName: string, ch: string, p: unknown) => {
      leadInCalls.push({ msg, journeyName, ch, p });
      return { leadIn: `About "${msg.slice(0, 40)}" — let me help you.`, ctaText: "Manage Subscription" };
    },
    launchJourney: async (args: unknown) => {
      journeyLaunches.push(args);
      return true;
    },
    startPlaybookFn: async (_admin: unknown, ticketId: string, playbookId: string, opts?: unknown) => {
      playbookStarts.push({ ticketId, playbookId, opts });
      // Simulate startPlaybook side-effect: flip active_playbook_id on the ticket row so a
      // follow-up read sees it (mirrors playbook-executor.startPlaybook).
      const t = state.tickets.find((r) => r.id === ticketId);
      if (t) t.active_playbook_id = playbookId;
    },
    executePlaybookStepFn: async (workspaceId: string, ticketId: string, msg: string, personality: unknown) => {
      stepCalls.push({ workspaceId, ticketId, msg, personality });
      return { action: "reply", response: "First playbook step reply.", systemNote: null };
    },
    ...overrides,
  };
  return { deps, sent, sysNotes, journeyLaunches, playbookStarts, stepCalls, leadInCalls };
}

// ── Phase-2 verification bullet 1: cancel journey → launchJourneyForTicket called (not prose) ──

test("chosen_path='journey' + active journey → launchJourneyForTicket is called (no prose fallback)", async () => {
  const state = baseState();
  const { deps, journeyLaunches, sent } = makeDeps(state);
  const result = await applySolDirection(makeDirection(), deps);
  assert.equal(result.applied, true, "the mechanism must be applied");
  assert.equal(result.kind, "journey");
  assert.equal(result.slug, "cancel_subscription");
  assert.equal(result.reason, "journey_launched");
  assert.equal(journeyLaunches.length, 1, "launchJourneyForTicket must be called exactly once");
  const args = journeyLaunches[0] as { journeyId: string; journeyName: string; triggerIntent: string; channel: string; leadIn: string; ctaText: string };
  assert.equal(args.journeyId, "j-cancel");
  assert.equal(args.journeyName, "Cancel Subscription");
  assert.equal(args.triggerIntent, "cancel_subscription");
  assert.equal(args.channel, "email");
  assert.equal(sent.length, 0, "no prose reply should be sent — the CTA is delivered by launchJourneyForTicket");
});

// ── Phase-2 verification bullet 2: leadIn references the customer's incoming message ──

test("journey leadIn is generated from the customer's incoming message (message-aware)", async () => {
  const state = baseState();
  const { deps, journeyLaunches, leadInCalls } = makeDeps(state);
  const direction = makeDirection();
  await applySolDirection(direction, {
    ...deps,
    message: "hey I need to cancel my ACV subscription — I moved and can't afford it",
  });
  assert.equal(leadInCalls.length, 1);
  const call = leadInCalls[0] as { msg: string; journeyName: string; ch: string };
  assert.match(call.msg, /cancel/i, "generateLeadIn must receive the customer's own message verbatim");
  assert.equal(call.journeyName, "Cancel Subscription");
  assert.equal(call.ch, "email");
  const launched = journeyLaunches[0] as { leadIn: string };
  assert.match(launched.leadIn, /cancel/i, "the launched journey's leadIn must reference the customer's message");
});

// ── Phase-2 verification bullet 3: self-service-only rule reroutes playbook → journey ──

test("self-service-only rule flags the intent → chosen_path='playbook' is overridden to the matching journey (no direct-cancel mutation)", async () => {
  const state = baseState();
  // Add a playbook explicitly matching the cancel intent so the Direction can legitimately point at it.
  state.playbooks.push({
    id: "pb-cancel",
    workspace_id: WS,
    slug: "cancel_for_customer",
    name: "Cancel for Customer",
    is_active: true,
  });
  const { deps, journeyLaunches, playbookStarts, stepCalls, sysNotes } = makeDeps(state, {
    loadRules: async () => [
      {
        category: "self_service_only",
        title: "cancel_subscription is self-service only",
        content: "Never cancel FOR the customer — always hand them the self-service cancel_subscription journey.",
      },
    ],
  });
  const direction = makeDirection({
    chosen_path: "playbook",
    plan: { playbook_slug: "cancel_for_customer" },
    intent: "cancel_subscription",
  });
  const result = await applySolDirection(direction, deps);
  assert.equal(result.applied, true);
  assert.equal(result.kind, "journey", "override MUST route to the journey path");
  assert.equal(result.slug, "cancel_subscription");
  assert.equal(result.reason, "self_service_overrode_playbook");
  assert.equal(result.override, "self_service");
  assert.equal(playbookStarts.length, 0, "no direct-cancel playbook mutation was dispatched");
  assert.equal(stepCalls.length, 0);
  assert.equal(journeyLaunches.length, 1, "the self-service journey was launched instead");
  assert.ok(
    sysNotes.some((n) => /Direction override.*self-service/.test(n)),
    "the override is stamped on the ticket log so it's grade-visible",
  );
});

// ── Phase-2 verification bullet 4: playbook-matched intent starts the playbook (not describe) ──

test("chosen_path='playbook' + no self-service rule → startPlaybook + executePlaybookStep run (not a describe reply)", async () => {
  const state = baseState();
  const { deps, playbookStarts, stepCalls, sent } = makeDeps(state);
  const direction = makeDirection({
    chosen_path: "playbook",
    intent: "refund_request",
    plan: { playbook_slug: "refund_with_recovery", playbook_seed_context: { order_id: "ord-9" } },
  });
  const result = await applySolDirection(direction, deps);
  assert.equal(result.applied, true);
  assert.equal(result.kind, "playbook");
  assert.equal(result.slug, "refund_with_recovery");
  assert.equal(result.reason, "playbook_started");
  assert.equal(playbookStarts.length, 1);
  const started = playbookStarts[0] as { playbookId: string; opts: { seed_context: Record<string, unknown> } };
  assert.equal(started.playbookId, "pb-refund");
  assert.deepEqual(started.opts.seed_context, { order_id: "ord-9" });
  assert.equal(stepCalls.length, 1);
  assert.equal(sent[0], "First playbook step reply.");
});

// ── Safety / fall-through cases ──

test("chosen_path='stateless' → not_applicable_path (falls through to Sonnet)", async () => {
  const state = baseState();
  const { deps, journeyLaunches, playbookStarts } = makeDeps(state);
  const result = await applySolDirection(
    makeDirection({ chosen_path: "stateless", plan: { action: "send_stateless_reply" } }),
    deps,
  );
  assert.equal(result.applied, false);
  assert.equal(result.kind, "none");
  assert.equal(result.reason, "not_applicable_path");
  assert.equal(journeyLaunches.length, 0);
  assert.equal(playbookStarts.length, 0);
});

test("chosen_path='journey' + slug not found → not applied, no launch, falls through to Sonnet", async () => {
  const state = baseState();
  const { deps, journeyLaunches } = makeDeps(state);
  const result = await applySolDirection(
    makeDirection({ plan: { journey_slug: "not_a_real_slug" } }),
    deps,
  );
  assert.equal(result.applied, false);
  assert.equal(result.reason, "journey_not_found");
  assert.equal(journeyLaunches.length, 0);
});

test("chosen_path='journey' + journey deactivated after Direction wrote → not applied", async () => {
  const state = baseState();
  (state.journey_definitions[0] as { is_active: boolean }).is_active = false;
  const { deps, journeyLaunches } = makeDeps(state);
  const result = await applySolDirection(makeDirection(), deps);
  assert.equal(result.applied, false);
  assert.equal(result.reason, "journey_not_found", "the is_active=true gate at apply time catches a race");
  assert.equal(journeyLaunches.length, 0);
});

test("chosen_path='playbook' + active_playbook_id already set → defers to the follow-up-turn shortcircuit", async () => {
  const state = baseState();
  (state.tickets[0] as { active_playbook_id: string | null }).active_playbook_id = "pb-refund";
  const { deps, playbookStarts, stepCalls } = makeDeps(state);
  const result = await applySolDirection(
    makeDirection({ chosen_path: "playbook", intent: "refund_request", plan: { playbook_slug: "refund_with_recovery" } }),
    deps,
  );
  assert.equal(result.applied, false);
  assert.equal(result.reason, "playbook_already_active");
  assert.equal(playbookStarts.length, 0, "the fresh-start path must not fire when a playbook is already running");
  assert.equal(stepCalls.length, 0);
});

test("superseded Direction is never applied (defensive re-assertion)", async () => {
  const state = baseState();
  const { deps, journeyLaunches } = makeDeps(state);
  const result = await applySolDirection(
    makeDirection({ superseded_at: "2026-07-08T01:00:00Z" }),
    deps,
  );
  assert.equal(result.applied, false);
  assert.equal(result.reason, "direction_superseded");
  assert.equal(journeyLaunches.length, 0);
});

test("chosen_path='journey' + launchJourney returns false → not applied, reason journey_launch_failed", async () => {
  const state = baseState();
  const { deps } = makeDeps(state, { launchJourney: async () => false });
  const result = await applySolDirection(makeDirection(), deps);
  assert.equal(result.applied, false);
  assert.equal(result.reason, "journey_launch_failed");
});

test("chosen_path='playbook' but no matching journey for the intent → self-service rule does NOT override (playbook still runs)", async () => {
  const state = baseState();
  // Remove the cancel journey so no matching active journey exists for the intent
  state.journey_definitions = [];
  const { deps, playbookStarts } = makeDeps(state, {
    loadRules: async () => [
      {
        category: "self_service_only",
        title: "cancel_subscription is self-service only",
        content: "Never cancel FOR the customer — always hand them the self-service cancel journey.",
      },
    ],
  });
  const result = await applySolDirection(
    makeDirection({ chosen_path: "playbook", plan: { playbook_slug: "refund_with_recovery" }, intent: "cancel_subscription" }),
    deps,
  );
  assert.equal(result.applied, true);
  assert.equal(result.kind, "playbook", "no matching journey → the rule is a preference, not a hard block");
  assert.equal(result.override, null);
  assert.equal(playbookStarts.length, 1);
});

// ── isSelfServiceOnlyIntent pure-function coverage ──

test("isSelfServiceOnlyIntent: category='self_service_only' + mentions intent slug → true", () => {
  assert.equal(
    isSelfServiceOnlyIntent(
      [{ category: "self_service_only", title: "t", content: "cancel_subscription must be self-service" }],
      "cancel_subscription",
    ),
    true,
  );
});

test("isSelfServiceOnlyIntent: category='self_service_only' + mentions intent by space-separated surface → true", () => {
  assert.equal(
    isSelfServiceOnlyIntent(
      [{ category: "self_service_only", title: "t", content: "cancel subscription is self-service only" }],
      "cancel_subscription",
    ),
    true,
  );
});

test("isSelfServiceOnlyIntent: 'never <verb> for the customer' phrasing matches → true", () => {
  assert.equal(
    isSelfServiceOnlyIntent(
      [{ category: "cx_conversation", title: "t", content: "Never cancel FOR the customer — hand them the cancel_subscription journey." }],
      "cancel_subscription",
    ),
    true,
  );
});

test("isSelfServiceOnlyIntent: mentions intent but no self-service marker → false", () => {
  assert.equal(
    isSelfServiceOnlyIntent(
      [{ category: "cx_conversation", title: "t", content: "For cancel_subscription tickets, offer a 20% loyalty save first." }],
      "cancel_subscription",
    ),
    false,
  );
});

test("isSelfServiceOnlyIntent: empty rules / empty intent → false", () => {
  assert.equal(isSelfServiceOnlyIntent([], "cancel_subscription"), false);
  assert.equal(
    isSelfServiceOnlyIntent(
      [{ category: "self_service_only", title: "t", content: "cancel" }],
      "",
    ),
    false,
  );
});
