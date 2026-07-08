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
import { writeDirection, TicketDirectionPlanError } from "./ticket-directions";

interface FakePlaybook {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
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
  nextDirectionId?: string;
}

function makeAdmin(seed: SeedInput = {}) {
  const state = {
    playbooks: (seed.playbooks ?? []).map((p) => ({ ...p })),
    directions: [] as FakeDirectionRow[],
  };
  let nextDirectionId = seed.nextDirectionId ?? "dir-generated";

  function makePlaybookBuilder() {
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
        const match = state.playbooks.find((p) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((p as unknown as Record<string, unknown>)[k] !== v) return false;
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
      if (table === "playbooks") return makePlaybookBuilder();
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
