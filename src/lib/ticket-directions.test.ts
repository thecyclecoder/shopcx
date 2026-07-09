/**
 * Unit tests for writeDirection's Phase-1 plan validator — Phase 1 of
 * docs/brain/specs/sol-session-chosen-playbook-selection-retire-brittle-triggers.md.
 *
 * The spec pins three behaviors the writer must enforce BEFORE the row lands, so downstream
 * cheap-execution can dispatch a Sol-chosen playbook without re-running the deterministic
 * matcher:
 *   - chosen_path='playbook' + no plan.playbook_slug → typed rejection (code=playbook_slug_missing).
 *   - chosen_path='playbook' + slug points at an unknown playbook → typed rejection with the slug
 *     echoed (code=playbook_slug_unknown).
 *   - happy path (slug matches a live playbook in this workspace) → writer accepts and returns the row.
 *
 * Exercised against an in-memory Supabase stub (the box has no prod creds; same pattern as
 * src/lib/inflection-detector.reSessionSol.test.ts). Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/ticket-directions.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  writeDirection,
  TicketDirectionPlanError,
  resolveSolChosenPlaybook,
  resolveSolChosenJourney,
  closeTicketOnResolvingReply,
  classifySolBoxTurnAction,
} from "./ticket-directions";

interface FakePlaybook {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
}

interface FakeJourney {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  trigger_intent?: string | null;
  is_active: boolean;
}

interface FakeDirectionRow {
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

interface SeedInput {
  playbooks?: FakePlaybook[];
  journeys?: FakeJourney[];
  nextDirectionId?: string;
}

function makeAdmin(seed: SeedInput = {}) {
  const state = {
    playbooks: (seed.playbooks ?? []).map((p) => ({ ...p })),
    journeys: (seed.journeys ?? []).map((j) => ({ ...j })),
    directions: [] as FakeDirectionRow[],
  };
  let nextDirectionId = seed.nextDirectionId ?? "dir-generated";

  function makeRowLookupBuilder<T extends Record<string, unknown>>(rows: T[]) {
    const filters: Record<string, unknown> = {};
    const builder = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      maybeSingle() {
        const match = rows.find((p) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((p as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        });
        return Promise.resolve({ data: match ? { id: match.id } : null, error: null });
      },
    };
    return builder;
  }

  function makeJourneyBuilder() {
    const filters: Record<string, unknown> = {};
    const builder = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      maybeSingle() {
        const match = state.journeys.find((j) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((j as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        });
        return Promise.resolve({ data: match ? { id: match.id } : null, error: null });
      },
    };
    return builder;
  }

  function makeDirectionInsertBuilder() {
    let payload: Record<string, unknown> = {};
    const builder = {
      insert(p: Record<string, unknown>) {
        payload = p;
        return builder;
      },
      select(_cols: string) {
        return builder;
      },
      single() {
        const row: FakeDirectionRow = {
          id: nextDirectionId,
          workspace_id: String(payload.workspace_id),
          ticket_id: String(payload.ticket_id),
          intent: String(payload.intent),
          context_summary: String(payload.context_summary),
          chosen_path: String(payload.chosen_path),
          plan: (payload.plan as Record<string, unknown>) ?? {},
          guardrails: (payload.guardrails as Record<string, unknown>) ?? {},
          authored_by: String(payload.authored_by),
          authored_at: "2026-07-08T00:00:00Z",
          superseded_at: null,
          resession_count: 0,
        };
        state.directions.push(row);
        return Promise.resolve({ data: row, error: null });
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "playbooks") return makeRowLookupBuilder(state.playbooks as unknown as Array<Record<string, unknown>>);
      if (table === "journey_definitions") return makeJourneyBuilder();
      if (table === "ticket_directions") return makeDirectionInsertBuilder();
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { admin: admin as unknown as import("@supabase/supabase-js").SupabaseClient, state };
}

const WS = "00000000-0000-0000-0000-0000000000ws";
const TID = "11111111-2222-3333-4444-555555555555";

test("chosen_path='playbook' + no plan.playbook_slug → rejected with typed error", async () => {
  const { admin, state } = makeAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "refund",
        context_summary: "customer wants refund",
        chosen_path: "playbook",
        plan: {},
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "playbook_slug_missing");
      return true;
    },
  );
  assert.equal(state.directions.length, 0, "no row should have been inserted");
});

test("chosen_path='playbook' + unknown slug → rejected with slug echoed on the error", async () => {
  const { admin, state } = makeAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "help",
        context_summary: "customer needs help",
        chosen_path: "playbook",
        plan: { playbook_slug: "assisted-purchase-classic" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "playbook_slug_unknown");
      assert.equal(err.slug, "assisted-purchase-classic");
      assert.match(err.message, /assisted-purchase-classic/);
      return true;
    },
  );
  assert.equal(state.directions.length, 0, "no row should have been inserted");
});

test("chosen_path='playbook' + known slug → row is inserted with plan intact", async () => {
  const { admin, state } = makeAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
    nextDirectionId: "dir-happy",
  });
  const seed = { order_id: "ord-9" };
  const row = await writeDirection(admin, {
    workspace_id: WS,
    ticket_id: TID,
    intent: "refund",
    context_summary: "customer wants refund",
    chosen_path: "playbook",
    plan: { playbook_slug: "refund", playbook_seed_context: seed },
  });
  assert.equal(row.id, "dir-happy");
  assert.equal(row.chosen_path, "playbook");
  assert.equal(row.plan.playbook_slug, "refund");
  assert.deepEqual(row.plan.playbook_seed_context, seed);
  assert.equal(state.directions.length, 1);
});

test("chosen_path='playbook' + slug matches only a DIFFERENT workspace → rejected", async () => {
  const { admin, state } = makeAdmin({
    playbooks: [
      {
        id: "pb-other",
        workspace_id: "00000000-0000-0000-0000-00000000ws2",
        slug: "refund",
        name: "Refund",
      },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "refund",
        context_summary: "customer wants refund",
        chosen_path: "playbook",
        plan: { playbook_slug: "refund" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "playbook_slug_unknown");
      return true;
    },
  );
  assert.equal(state.directions.length, 0, "cross-workspace slug must not authorize the write");
});

test("chosen_path='stateless' → writer skips the playbook lookup entirely", async () => {
  const { admin, state } = makeAdmin({ playbooks: [], nextDirectionId: "dir-stateless" });
  const row = await writeDirection(admin, {
    workspace_id: WS,
    ticket_id: TID,
    intent: "answer question",
    context_summary: "customer asked about shipping",
    chosen_path: "stateless",
    plan: { action: "send_stateless_reply" },
  });
  assert.equal(row.id, "dir-stateless");
  assert.equal(row.chosen_path, "stateless");
  assert.equal(state.directions.length, 1);
});

test("chosen_path='needs_info' → writer skips the playbook lookup entirely", async () => {
  const { admin, state } = makeAdmin({ playbooks: [], nextDirectionId: "dir-needs-info" });
  const row = await writeDirection(admin, {
    workspace_id: WS,
    ticket_id: TID,
    intent: "collect address",
    context_summary: "customer wants a shipping change but no new address",
    chosen_path: "needs_info",
    plan: { needs: ["shipping_address"] },
  });
  assert.equal(row.id, "dir-needs-info");
  assert.equal(row.chosen_path, "needs_info");
  assert.equal(state.directions.length, 1);
});

test("chosen_path='playbook' + non-string slug → rejected with playbook_slug_not_string", async () => {
  const { admin, state } = makeAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "refund",
        context_summary: "customer wants refund",
        chosen_path: "playbook",
        plan: { playbook_slug: 42 as unknown as string },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "playbook_slug_not_string");
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

// Phase 3 of [[../../docs/brain/specs/sol-reviews-policies-and-never-bais-an-out-of-policy-outcome-full-research-session]]:
// tighten the empty-slug rejection to also cover a whitespace-only string. Sol's north-star rule
// on the no-playbook-match case is "chosen_path='stateless' — never claim playbook with an empty
// slug" — a whitespace-only slug is morally empty (Sol trying to satisfy the field without a
// real match). The writer must reject it with the same typed code the empty case throws, so a
// downstream caller can render one diagnostic instead of routing through the workspace lookup
// (which would surface it as playbook_slug_unknown and read as "we don't have that playbook"
// rather than the truer "you didn't pick one").
test("chosen_path='playbook' + whitespace-only slug → rejected with playbook_slug_not_string (Phase 3 honest-stateless invariant)", async () => {
  const { admin, state } = makeAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "refund",
        context_summary: "customer wants refund",
        chosen_path: "playbook",
        plan: { playbook_slug: "   " },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "playbook_slug_not_string");
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

// ──────────────────────────────────────────────────────────────────────
// journey_slug validator — Phase 1 of
// docs/brain/specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta.md.
// The writer confirms plan.journey_slug points at a live is_active journey in this workspace so
// downstream cheap-execution can APPLY the journey (launchJourneyForTicket), not describe it.
// ──────────────────────────────────────────────────────────────────────

test("chosen_path='journey' + no plan.journey_slug → rejected with typed error", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      { id: "j-1", workspace_id: WS, slug: "cancel_subscription", name: "Cancel Subscription", is_active: true },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "cancel_subscription",
        context_summary: "customer wants to cancel",
        chosen_path: "journey",
        plan: {},
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "journey_slug_missing");
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

test("chosen_path='journey' + unknown slug → rejected with slug echoed", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      { id: "j-1", workspace_id: WS, slug: "cancel_subscription", name: "Cancel Subscription", is_active: true },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "cancel_subscription",
        context_summary: "customer wants to cancel",
        chosen_path: "journey",
        plan: { journey_slug: "cancel_madeup" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "journey_slug_unknown");
      assert.equal(err.slug, "cancel_madeup");
      assert.match(err.message, /cancel_madeup/);
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

test("chosen_path='journey' + inactive journey slug → rejected as unknown (is_active gate)", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      { id: "j-1", workspace_id: WS, slug: "retired_journey", name: "Retired Journey", is_active: false },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "retired",
        context_summary: "customer wants a retired flow",
        chosen_path: "journey",
        plan: { journey_slug: "retired_journey" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "journey_slug_unknown");
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

test("chosen_path='journey' + known active slug → row is inserted with plan intact", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      {
        id: "j-1",
        workspace_id: WS,
        slug: "cancel_subscription",
        name: "Cancel Subscription",
        is_active: true,
      },
    ],
    nextDirectionId: "dir-journey",
  });
  const row = await writeDirection(admin, {
    workspace_id: WS,
    ticket_id: TID,
    intent: "cancel_subscription",
    context_summary: "customer wants to cancel",
    chosen_path: "journey",
    plan: { journey_slug: "cancel_subscription" },
  });
  assert.equal(row.id, "dir-journey");
  assert.equal(row.chosen_path, "journey");
  assert.equal(row.plan.journey_slug, "cancel_subscription");
  assert.equal(state.directions.length, 1);
});

test("chosen_path='journey' + slug matches only a DIFFERENT workspace → rejected", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      {
        id: "j-other",
        workspace_id: "00000000-0000-0000-0000-00000000ws2",
        slug: "cancel_subscription",
        name: "Cancel Subscription",
        is_active: true,
      },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "cancel_subscription",
        context_summary: "customer wants to cancel",
        chosen_path: "journey",
        plan: { journey_slug: "cancel_subscription" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "journey_slug_unknown");
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

test("chosen_path='journey' + whitespace-only slug → rejected with journey_slug_not_string", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      { id: "j-1", workspace_id: WS, slug: "cancel_subscription", name: "Cancel", is_active: true },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "cancel",
        context_summary: "customer wants to cancel",
        chosen_path: "journey",
        plan: { journey_slug: "   " },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "journey_slug_not_string");
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

// ──────────────────────────────────────────────────────────────────────
// resolveSolChosenPlaybook — Phase 2 of
// docs/brain/specs/sol-session-chosen-playbook-selection-retire-brittle-triggers.md.
// The helper returns non-null only when Sol's live Direction names a slug,
// the ticket is not already on a playbook, and the slug resolves in this
// workspace — otherwise the caller falls through to the deterministic matcher.
// ──────────────────────────────────────────────────────────────────────

interface FakeTicket {
  id: string;
  workspace_id: string;
  active_playbook_id: string | null;
}

interface DispatchSeed {
  playbooks?: FakePlaybook[];
  tickets?: FakeTicket[];
  directions?: Array<{
    id: string;
    workspace_id: string;
    ticket_id: string;
    chosen_path: "playbook" | "stateless" | "needs_info";
    plan: Record<string, unknown>;
    superseded_at: string | null;
  }>;
}

function makeDispatchAdmin(seed: DispatchSeed) {
  const state = {
    playbooks: (seed.playbooks ?? []).map((p) => ({ ...p })),
    tickets: (seed.tickets ?? []).map((t) => ({ ...t })),
    directions: (seed.directions ?? []).map((d) => ({
      // getLiveDirection selects the full COLS list; fill in benign defaults for the rest.
      id: d.id,
      workspace_id: d.workspace_id,
      ticket_id: d.ticket_id,
      intent: "test",
      context_summary: "test",
      chosen_path: d.chosen_path,
      plan: { ...d.plan },
      guardrails: {},
      authored_by: "sol_box_session",
      authored_at: "2026-07-08T00:00:00Z",
      superseded_at: d.superseded_at,
      resession_count: 0,
    })),
  };

  function selectBuilder<T>(rows: T[]) {
    const filters: Record<string, unknown> = {};
    let onlyLive = false;
    const builder = {
      select(_cols: string) {
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
        const match = (rows as unknown as Array<Record<string, unknown>>).find((r) => {
          if (onlyLive && r.superseded_at !== null) return false;
          for (const [k, v] of Object.entries(filters)) {
            if (r[k] !== v) return false;
          }
          return true;
        });
        return Promise.resolve({ data: (match as unknown as T) ?? null, error: null });
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "ticket_directions") return selectBuilder(state.directions);
      if (table === "tickets") return selectBuilder(state.tickets);
      if (table === "playbooks") return selectBuilder(state.playbooks);
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { admin: admin as unknown as import("@supabase/supabase-js").SupabaseClient, state };
}

test("resolveSolChosenPlaybook: no live Direction → null (matcher path preserved)", async () => {
  const { admin } = makeDispatchAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
    tickets: [{ id: TID, workspace_id: WS, active_playbook_id: null }],
    directions: [],
  });
  const out = await resolveSolChosenPlaybook(admin, WS, TID);
  assert.equal(out, null);
});

test("resolveSolChosenPlaybook: live Direction with chosen_path='stateless' → null (bypass matcher AND no playbook)", async () => {
  const { admin } = makeDispatchAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
    tickets: [{ id: TID, workspace_id: WS, active_playbook_id: null }],
    directions: [
      { id: "dir-1", workspace_id: WS, ticket_id: TID, chosen_path: "stateless", plan: {}, superseded_at: null },
    ],
  });
  const out = await resolveSolChosenPlaybook(admin, WS, TID);
  assert.equal(out, null);
});

test("resolveSolChosenPlaybook: live Direction with chosen_path='needs_info' → null", async () => {
  const { admin } = makeDispatchAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
    tickets: [{ id: TID, workspace_id: WS, active_playbook_id: null }],
    directions: [
      { id: "dir-1", workspace_id: WS, ticket_id: TID, chosen_path: "needs_info", plan: { needs: ["address"] }, superseded_at: null },
    ],
  });
  const out = await resolveSolChosenPlaybook(admin, WS, TID);
  assert.equal(out, null);
});

test("resolveSolChosenPlaybook: chosen_path='playbook' but active_playbook_id already set → null (follow-up turn, shortcircuit owns it)", async () => {
  const { admin } = makeDispatchAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
    tickets: [{ id: TID, workspace_id: WS, active_playbook_id: "pb-1" }],
    directions: [
      {
        id: "dir-1", workspace_id: WS, ticket_id: TID, chosen_path: "playbook",
        plan: { playbook_slug: "refund" }, superseded_at: null,
      },
    ],
  });
  const out = await resolveSolChosenPlaybook(admin, WS, TID);
  assert.equal(out, null);
});

test("resolveSolChosenPlaybook: playbook_slug points at slug not in this workspace → null", async () => {
  const { admin } = makeDispatchAdmin({
    playbooks: [
      { id: "pb-other", workspace_id: "00000000-0000-0000-0000-00000000ws2", slug: "refund", name: "Refund" },
    ],
    tickets: [{ id: TID, workspace_id: WS, active_playbook_id: null }],
    directions: [
      {
        id: "dir-1", workspace_id: WS, ticket_id: TID, chosen_path: "playbook",
        plan: { playbook_slug: "refund" }, superseded_at: null,
      },
    ],
  });
  const out = await resolveSolChosenPlaybook(admin, WS, TID);
  assert.equal(out, null);
});

test("resolveSolChosenPlaybook: happy path — resolves to { playbook_id, slug, seed_context }", async () => {
  const seed = { order_id: "ord-42", subscription_id: "sub-7" };
  const { admin } = makeDispatchAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "assisted-purchase-classic", name: "Assisted Purchase" }],
    tickets: [{ id: TID, workspace_id: WS, active_playbook_id: null }],
    directions: [
      {
        id: "dir-1", workspace_id: WS, ticket_id: TID, chosen_path: "playbook",
        plan: { playbook_slug: "assisted-purchase-classic", playbook_seed_context: seed },
        superseded_at: null,
      },
    ],
  });
  const out = await resolveSolChosenPlaybook(admin, WS, TID);
  assert.ok(out !== null, "expected non-null resolution");
  assert.equal(out!.playbook_id, "pb-1");
  assert.equal(out!.slug, "assisted-purchase-classic");
  assert.deepEqual(out!.seed_context, seed);
});

test("resolveSolChosenPlaybook: happy path with omitted seed_context → seed defaults to {}", async () => {
  const { admin } = makeDispatchAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
    tickets: [{ id: TID, workspace_id: WS, active_playbook_id: null }],
    directions: [
      {
        id: "dir-1", workspace_id: WS, ticket_id: TID, chosen_path: "playbook",
        plan: { playbook_slug: "refund" }, superseded_at: null,
      },
    ],
  });
  const out = await resolveSolChosenPlaybook(admin, WS, TID);
  assert.ok(out !== null);
  assert.deepEqual(out!.seed_context, {});
});

// ──────────────────────────────────────────────────────────────────────
// launch_journey_slug — Phase 1 of
// docs/brain/specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend.md.
// The writer validates the slug resolves to an active journey_definitions row (workspace-
// scoped) BEFORE the Direction lands, so a Direction that names an unknown/inactive slug
// bails HERE rather than at the launcher — same confirming-predicate pattern as the
// playbook_slug gate above.
// ──────────────────────────────────────────────────────────────────────

test("plan.launch_journey_slug empty string → rejected with journey_slug_not_string", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      {
        id: "jd-ship",
        workspace_id: WS,
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: true,
      },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "customer moved",
        context_summary: "customer moved and wants to update address",
        chosen_path: "stateless",
        plan: { action: "send_stateless_reply", launch_journey_slug: "" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "journey_slug_not_string");
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

test("plan.launch_journey_slug whitespace-only → rejected with journey_slug_not_string", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      {
        id: "jd-ship",
        workspace_id: WS,
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: true,
      },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "customer moved",
        context_summary: "customer moved and wants to update address",
        chosen_path: "stateless",
        plan: { action: "send_stateless_reply", launch_journey_slug: "   " },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "journey_slug_not_string");
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

test("plan.launch_journey_slug points at unknown slug → rejected with slug echoed", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      {
        id: "jd-ship",
        workspace_id: WS,
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: true,
      },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "customer moved",
        context_summary: "customer moved and wants to update address",
        chosen_path: "stateless",
        plan: { action: "send_stateless_reply", launch_journey_slug: "not-a-real-journey" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "journey_slug_unknown");
      assert.equal(err.slug, "not-a-real-journey");
      assert.match(err.message, /not-a-real-journey/);
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

test("plan.launch_journey_slug matches only a DIFFERENT workspace → rejected", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      {
        id: "jd-other",
        workspace_id: "00000000-0000-0000-0000-00000000ws2",
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: true,
      },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "customer moved",
        context_summary: "customer moved and wants to update address",
        chosen_path: "stateless",
        plan: { action: "send_stateless_reply", launch_journey_slug: "shipping-address" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "journey_slug_unknown");
      return true;
    },
  );
  assert.equal(state.directions.length, 0, "cross-workspace journey slug must not authorize the launch");
});

test("plan.launch_journey_slug matches an INACTIVE journey → rejected (is_active=false is not authorized)", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      {
        id: "jd-ship",
        workspace_id: WS,
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: false,
      },
    ],
  });
  await assert.rejects(
    () =>
      writeDirection(admin, {
        workspace_id: WS,
        ticket_id: TID,
        intent: "customer moved",
        context_summary: "customer moved and wants to update address",
        chosen_path: "stateless",
        plan: { action: "send_stateless_reply", launch_journey_slug: "shipping-address" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof TicketDirectionPlanError);
      assert.equal(err.code, "journey_slug_unknown");
      return true;
    },
  );
  assert.equal(state.directions.length, 0);
});

test("plan.launch_journey_slug happy path (stateless + shipping-address) → Direction lands with slug on plan", async () => {
  const { admin, state } = makeAdmin({
    journeys: [
      {
        id: "jd-ship",
        workspace_id: WS,
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: true,
      },
    ],
    nextDirectionId: "dir-move",
  });
  const row = await writeDirection(admin, {
    workspace_id: WS,
    ticket_id: TID,
    intent: "customer moved and wants to update address",
    context_summary: "in-policy address change; active internal subscription",
    chosen_path: "stateless",
    plan: { action: "send_stateless_reply", launch_journey_slug: "shipping-address" },
  });
  assert.equal(row.id, "dir-move");
  assert.equal(row.chosen_path, "stateless");
  assert.equal(row.plan.launch_journey_slug, "shipping-address");
  assert.equal(state.directions.length, 1);
});

// ──────────────────────────────────────────────────────────────────────
// resolveSolChosenJourney — the resolver the worker consults AFTER
// writeDirection succeeds to decide whether to route the customer-facing
// output through launchJourneyForTicket instead of the plain reply send.
// ──────────────────────────────────────────────────────────────────────

interface DispatchJourneySeed {
  journeys?: FakeJourney[];
  directions?: Array<{
    id: string;
    workspace_id: string;
    ticket_id: string;
    chosen_path: "playbook" | "stateless" | "needs_info";
    plan: Record<string, unknown>;
    superseded_at: string | null;
  }>;
}

function makeJourneyDispatchAdmin(seed: DispatchJourneySeed) {
  const state = {
    journeys: (seed.journeys ?? []).map((j) => ({ ...j })),
    directions: (seed.directions ?? []).map((d) => ({
      id: d.id,
      workspace_id: d.workspace_id,
      ticket_id: d.ticket_id,
      intent: "test",
      context_summary: "test",
      chosen_path: d.chosen_path,
      plan: { ...d.plan },
      guardrails: {},
      authored_by: "sol_box_session",
      authored_at: "2026-07-08T00:00:00Z",
      superseded_at: d.superseded_at,
      resession_count: 0,
    })),
  };

  function selectBuilder<T>(rows: T[], cols: string) {
    const filters: Record<string, unknown> = {};
    let onlyLive = false;
    const builder = {
      select(_cols: string) {
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
        const match = (rows as unknown as Array<Record<string, unknown>>).find((r) => {
          if (onlyLive && r.superseded_at !== null) return false;
          for (const [k, v] of Object.entries(filters)) {
            if (r[k] !== v) return false;
          }
          return true;
        });
        if (!match) return Promise.resolve({ data: null, error: null });
        if (cols === "id, name, trigger_intent") {
          return Promise.resolve({
            data: {
              id: match.id,
              name: match.name,
              trigger_intent: match.trigger_intent ?? null,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: match as unknown as T, error: null });
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "ticket_directions") return selectBuilder(state.directions, "*");
      if (table === "journey_definitions") return selectBuilder(state.journeys, "id, name, trigger_intent");
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { admin: admin as unknown as import("@supabase/supabase-js").SupabaseClient, state };
}

test("resolveSolChosenJourney: no live Direction → null", async () => {
  const { admin } = makeJourneyDispatchAdmin({
    journeys: [
      {
        id: "jd-ship",
        workspace_id: WS,
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: true,
      },
    ],
    directions: [],
  });
  const out = await resolveSolChosenJourney(admin, WS, TID);
  assert.equal(out, null);
});

test("resolveSolChosenJourney: live Direction without launch_journey_slug → null", async () => {
  const { admin } = makeJourneyDispatchAdmin({
    journeys: [
      {
        id: "jd-ship",
        workspace_id: WS,
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: true,
      },
    ],
    directions: [
      { id: "dir-1", workspace_id: WS, ticket_id: TID, chosen_path: "stateless", plan: { action: "send_stateless_reply" }, superseded_at: null },
    ],
  });
  const out = await resolveSolChosenJourney(admin, WS, TID);
  assert.equal(out, null);
});

test("resolveSolChosenJourney: superseded Direction → null (superseded_at IS NOT NULL disables the branch)", async () => {
  const { admin } = makeJourneyDispatchAdmin({
    journeys: [
      {
        id: "jd-ship",
        workspace_id: WS,
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: true,
      },
    ],
    directions: [
      {
        id: "dir-1",
        workspace_id: WS,
        ticket_id: TID,
        chosen_path: "stateless",
        plan: { action: "send_stateless_reply", launch_journey_slug: "shipping-address" },
        superseded_at: "2026-07-08T01:00:00Z",
      },
    ],
  });
  const out = await resolveSolChosenJourney(admin, WS, TID);
  assert.equal(out, null);
});

test("resolveSolChosenJourney: cross-workspace slug → null (mis-authored Direction cannot dispatch)", async () => {
  const { admin } = makeJourneyDispatchAdmin({
    journeys: [
      {
        id: "jd-other",
        workspace_id: "00000000-0000-0000-0000-00000000ws2",
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: true,
      },
    ],
    directions: [
      {
        id: "dir-1",
        workspace_id: WS,
        ticket_id: TID,
        chosen_path: "stateless",
        plan: { launch_journey_slug: "shipping-address" },
        superseded_at: null,
      },
    ],
  });
  const out = await resolveSolChosenJourney(admin, WS, TID);
  assert.equal(out, null);
});

test("resolveSolChosenJourney: happy path — returns { journey_id, slug, name, trigger_intent }", async () => {
  const { admin } = makeJourneyDispatchAdmin({
    journeys: [
      {
        id: "jd-ship",
        workspace_id: WS,
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: "shipping_address",
        is_active: true,
      },
    ],
    directions: [
      {
        id: "dir-1",
        workspace_id: WS,
        ticket_id: TID,
        chosen_path: "stateless",
        plan: { action: "send_stateless_reply", launch_journey_slug: "shipping-address" },
        superseded_at: null,
      },
    ],
  });
  const out = await resolveSolChosenJourney(admin, WS, TID);
  assert.ok(out !== null, "expected non-null resolution");
  assert.equal(out!.journey_id, "jd-ship");
  assert.equal(out!.slug, "shipping-address");
  assert.equal(out!.name, "Confirm Shipping Address");
  assert.equal(out!.trigger_intent, "shipping_address");
});

test("resolveSolChosenJourney: happy path with null trigger_intent → falls back to the slug", async () => {
  const { admin } = makeJourneyDispatchAdmin({
    journeys: [
      {
        id: "jd-ship",
        workspace_id: WS,
        slug: "shipping-address",
        name: "Confirm Shipping Address",
        trigger_intent: null,
        is_active: true,
      },
    ],
    directions: [
      {
        id: "dir-1",
        workspace_id: WS,
        ticket_id: TID,
        chosen_path: "stateless",
        plan: { launch_journey_slug: "shipping-address" },
        superseded_at: null,
      },
    ],
  });
  const out = await resolveSolChosenJourney(admin, WS, TID);
  assert.ok(out !== null);
  assert.equal(out!.trigger_intent, "shipping-address");
});

test("resolveSolChosenPlaybook: superseded Direction → null (superseded_at IS NOT NULL disables the branch)", async () => {
  const { admin } = makeDispatchAdmin({
    playbooks: [{ id: "pb-1", workspace_id: WS, slug: "refund", name: "Refund" }],
    tickets: [{ id: TID, workspace_id: WS, active_playbook_id: null }],
    directions: [
      {
        id: "dir-1", workspace_id: WS, ticket_id: TID, chosen_path: "playbook",
        plan: { playbook_slug: "refund" }, superseded_at: "2026-07-08T01:00:00Z",
      },
    ],
  });
  const out = await resolveSolChosenPlaybook(admin, WS, TID);
  assert.equal(out, null);
});

// ── Phase 1 of sol-closes-ticket-on-resolving-reply-so-cora-grades-it ──
// closeTicketOnResolvingReply is the shared "message_sent → close" write mirroring the old
// unified-ticket-handler `setStatus`. These tests pin (a) the six fields the update writes, (b) the
// workspace_id + id compound predicate (Learning #6 — cross-workspace cannot authorize a close),
// and (c) that closed_at + updated_at are set to a fresh timestamp (not null).

function makeCloseAdmin() {
  let captured: {
    table?: string;
    payload?: Record<string, unknown>;
    filters?: Record<string, unknown>;
  } | null = null;
  const admin = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        update(p: Record<string, unknown>) {
          captured = { table, payload: p, filters };
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        then(resolve: (v: { error: null }) => void) {
          resolve({ error: null });
        },
      };
      return builder;
    },
  };
  return {
    admin: admin as unknown as import("@supabase/supabase-js").SupabaseClient,
    captured: () => captured,
  };
}

test("closeTicketOnResolvingReply writes the six-field message_sent→close update on tickets", async () => {
  const { admin, captured } = makeCloseAdmin();
  await closeTicketOnResolvingReply(admin, { workspace_id: WS, ticket_id: TID });
  const c = captured();
  assert.ok(c, "update must fire");
  assert.equal(c!.table, "tickets");
  const payload = c!.payload as Record<string, unknown>;
  assert.equal(payload.status, "closed");
  assert.equal(typeof payload.closed_at, "string");
  assert.ok(!Number.isNaN(Date.parse(payload.closed_at as string)));
  assert.equal(typeof payload.updated_at, "string");
  assert.ok(!Number.isNaN(Date.parse(payload.updated_at as string)));
  // Clears the escalation triple so a previously-escalated ticket doesn't linger in the
  // escalation view after Sol resolves it.
  assert.equal(payload.escalated_at, null);
  assert.equal(payload.escalated_to, null);
  assert.equal(payload.escalation_reason, null);
});

test("closeTicketOnResolvingReply is scoped by workspace_id + id (a cross-workspace id cannot authorize the close)", async () => {
  const { admin, captured } = makeCloseAdmin();
  await closeTicketOnResolvingReply(admin, { workspace_id: WS, ticket_id: TID });
  const c = captured();
  assert.ok(c, "update must fire");
  assert.deepEqual(c!.filters, { workspace_id: WS, id: TID });
});

// ── Phase 2 of sol-closes-ticket-on-resolving-reply-so-cora-grades-it ──
// classifySolBoxTurnAction — founder rule (2026-07-09): EVERY Sol message closes the ticket.
// A closed ticket reopens on the customer's next inbound, and the mechanism Sol armed at first
// touch (playbook → active_playbook_id → sol-playbook-shortcircuit) drives from there. The prior
// taxonomy left playbook/journey tickets open ("status_managed") expecting the mechanism to close
// them — but the box never armed the mechanism, so they sat dormant-and-open (marty 125741eb).
// Now: send_ok → message_sent (close); a FAILED send is the only thing that keeps it open.

test("classifySolBoxTurnAction: chosen_path='stateless' + send_ok=true → message_sent (CLOSE)", () => {
  assert.equal(classifySolBoxTurnAction({ chosen_path: "stateless", send_ok: true }), "message_sent");
});

test("classifySolBoxTurnAction: any send_ok=false → keep_open (send failed, ticket must NOT close)", () => {
  // A reply that failed to ship must NOT close the ticket — the customer never saw it, so a human
  // retries via Improve while the ticket stays open. Holds for every chosen_path.
  assert.equal(classifySolBoxTurnAction({ chosen_path: "stateless", send_ok: false }), "keep_open");
  assert.equal(classifySolBoxTurnAction({ chosen_path: "playbook", send_ok: false }), "keep_open");
  assert.equal(classifySolBoxTurnAction({ chosen_path: "needs_info", send_ok: false }), "keep_open");
});

test("classifySolBoxTurnAction: chosen_path='needs_info' + send_ok=true → message_sent (the question shipped; reply reopens)", () => {
  // A clarifying question IS a Sol message — it closes. The customer's next inbound reopens the
  // ticket and Sol continues.
  assert.equal(classifySolBoxTurnAction({ chosen_path: "needs_info", send_ok: true }), "message_sent");
});

test("classifySolBoxTurnAction: chosen_path='playbook' + send_ok=true → message_sent (Sol's opening shipped; the armed playbook drives on reply)", () => {
  // The box arms the playbook reply-gated at first touch, then closes. A customer reply reopens
  // the ticket and the sol-playbook-shortcircuit resumes the playbook.
  assert.equal(classifySolBoxTurnAction({ chosen_path: "playbook", send_ok: true }), "message_sent");
});

test("classifySolBoxTurnAction: chosen_path='journey' + send_ok=true → message_sent", () => {
  assert.equal(classifySolBoxTurnAction({ chosen_path: "journey", send_ok: true }), "message_sent");
});

test("classifySolBoxTurnAction: unknown chosen_path + send_ok=true → message_sent (a message shipped, so it closes)", () => {
  // The rule keys on send_ok, not on the path string — a shipped message closes regardless.
  assert.equal(classifySolBoxTurnAction({ chosen_path: "unknown", send_ok: true }), "message_sent");
});

// ── Founder rule: CLOSE authorization is exactly send_ok ──
// Pinned as an explicit check across every disposition so the rule can't silently drift back to
// leaving mechanism tickets open.
test("classifySolBoxTurnAction: 'message_sent' iff send_ok — across every chosen_path", () => {
  const paths = ["stateless", "needs_info", "playbook", "journey", "unknown"];
  const sends = [true, false];
  for (const chosen_path of paths) {
    for (const send_ok of sends) {
      const action = classifySolBoxTurnAction({ chosen_path, send_ok });
      assert.equal(
        action === "message_sent",
        send_ok,
        `chosen_path='${chosen_path}' send_ok=${send_ok} → action='${action}' — CLOSE authorization must be exactly send_ok`,
      );
    }
  }
});
