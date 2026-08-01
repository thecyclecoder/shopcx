/**
 * Regression test for the AsyncLocalStorage-backed workspace scope on
 * [[./app-owner-action-escalation]] — proves two overlapping app-owner-action
 * scopes for DIFFERENT workspaces each see their own workspace id after
 * interleaved awaits, so a Meta `app_owner_action_required` fired from
 * publish A never books the CEO card against publish B's workspace.
 *
 * The previous module-global `setCurrentAppOwnerActionWorkspaceScope` +
 * `finally` cleanup pattern raced under concurrent Inngest publishes: setter
 * A → setter B → publish A's Graph call fires the handler → handler reads B.
 * This test would fail on that pattern; it passes with the ALS wrapper.
 *
 * Run:
 *   npx tsx --test src/lib/meta/app-owner-action-escalation.workspace-scope.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentAppOwnerActionWorkspaceScope,
  installDefaultAppOwnerActionEscalationHandler,
  runWithAppOwnerActionWorkspaceScope,
} from "./app-owner-action-escalation";
import {
  graphError,
  getAppOwnerActionRequiredHandler,
  registerAppOwnerActionRequiredHandler,
} from "./graph-retry";

test("runWithAppOwnerActionWorkspaceScope — two overlapping scopes for different workspaces stay isolated across interleaved awaits, and the escalation handler sees each chain's own workspace", async () => {
  const observed: Array<{ chain: "A" | "B"; workspaceId: string | null }> = [];
  const handlerCalls: Array<{ workspaceId: string | null; label: string }> = [];

  // Stub the escalation handler with the SAME shape the module installs — the
  // handler reads `getCurrentAppOwnerActionWorkspaceScope()`, which now returns
  // the AsyncLocalStorage store bound to the caller's chain.
  registerAppOwnerActionRequiredHandler((ctx) => {
    handlerCalls.push({
      workspaceId: getCurrentAppOwnerActionWorkspaceScope(),
      label: ctx.label,
    });
  });

  try {
    // Two overlapping publishes for different workspaces. Each yields to the
    // microtask queue (and a macrotask via setTimeout) so the runtimes are
    // guaranteed to interleave — the module-global setter would have B
    // overwrite A's scope before A's Graph call fires.
    const chainA = runWithAppOwnerActionWorkspaceScope("ws-A", async () => {
      observed.push({ chain: "A", workspaceId: getCurrentAppOwnerActionWorkspaceScope() });
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      observed.push({ chain: "A", workspaceId: getCurrentAppOwnerActionWorkspaceScope() });
      // Fire the Graph handler from INSIDE chain A's ALS scope after B has run.
      const handler = getAppOwnerActionRequiredHandler();
      handler?.({
        label: "GET act_A/insights",
        status: 400,
        error: graphError(400, { message: "Data Use Checkup required" }),
      });
      return getCurrentAppOwnerActionWorkspaceScope();
    });

    const chainB = runWithAppOwnerActionWorkspaceScope("ws-B", async () => {
      observed.push({ chain: "B", workspaceId: getCurrentAppOwnerActionWorkspaceScope() });
      await Promise.resolve();
      await Promise.resolve();
      observed.push({ chain: "B", workspaceId: getCurrentAppOwnerActionWorkspaceScope() });
      const handler = getAppOwnerActionRequiredHandler();
      handler?.({
        label: "GET act_B/insights",
        status: 400,
        error: graphError(400, { message: "Data Use Checkup required" }),
      });
      return getCurrentAppOwnerActionWorkspaceScope();
    });

    const [aFinal, bFinal] = await Promise.all([chainA, chainB]);

    // Each chain sees ONLY its own workspace at every observation point.
    assert.deepEqual(
      observed.filter((o) => o.chain === "A").map((o) => o.workspaceId),
      ["ws-A", "ws-A"],
      "chain A's ALS scope must stay ws-A across interleaved awaits (never leak to ws-B)",
    );
    assert.deepEqual(
      observed.filter((o) => o.chain === "B").map((o) => o.workspaceId),
      ["ws-B", "ws-B"],
      "chain B's ALS scope must stay ws-B across interleaved awaits (never leak to ws-A)",
    );
    assert.equal(aFinal, "ws-A");
    assert.equal(bFinal, "ws-B");

    // The handler fires from within each chain's ALS scope, so it books
    // against the chain's own workspace — no cross-workspace leak.
    const aHandler = handlerCalls.find((c) => c.label === "GET act_A/insights");
    const bHandler = handlerCalls.find((c) => c.label === "GET act_B/insights");
    assert.equal(aHandler?.workspaceId, "ws-A", "handler fired from chain A binds ws-A");
    assert.equal(bHandler?.workspaceId, "ws-B", "handler fired from chain B binds ws-B");
  } finally {
    registerAppOwnerActionRequiredHandler(null);
  }
});

test("getCurrentAppOwnerActionWorkspaceScope — returns null outside any runWithAppOwnerActionWorkspaceScope call", () => {
  assert.equal(getCurrentAppOwnerActionWorkspaceScope(), null);
});

test("installDefaultAppOwnerActionEscalationHandler — the installed handler resolves its workspace from the ALS store at fire time, not from a module-global", async () => {
  const inserted: Array<{ workspaceId: string; dedupeKey: string; label: string }> = [];

  // Minimal Supabase admin stub that records the insert and asserts the
  // caller's workspace, so a leak from chain A into chain B would surface as a
  // wrong workspace_id on the inserted row.
  const stubAdmin = {
    from(_table: string) {
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        insert(row: { workspace_id: string; metadata: { dedupe_key: string; calling_function: string } }) {
          inserted.push({
            workspaceId: row.workspace_id,
            dedupeKey: row.metadata.dedupe_key,
            label: row.metadata.calling_function,
          });
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as Parameters<typeof installDefaultAppOwnerActionEscalationHandler>[0];

  installDefaultAppOwnerActionEscalationHandler(stubAdmin);

  try {
    const wait = new Promise<void>((resolve) => setTimeout(resolve, 5));

    const chainA = runWithAppOwnerActionWorkspaceScope("ws-A", async () => {
      await Promise.resolve();
      await wait;
      const handler = getAppOwnerActionRequiredHandler();
      // handler is async (awaits the Supabase insert) — await via microtask.
      handler?.({
        label: "GET act_A/insights",
        status: 400,
        error: graphError(400, { message: "Data Use Checkup" }),
      });
    });

    const chainB = runWithAppOwnerActionWorkspaceScope("ws-B", async () => {
      await Promise.resolve();
      await wait;
      const handler = getAppOwnerActionRequiredHandler();
      handler?.({
        label: "GET act_B/insights",
        status: 400,
        error: graphError(400, { message: "Data Use Checkup" }),
      });
    });

    await Promise.all([chainA, chainB]);
    // Yield twice so the fire-and-forget inserts from the handler resolve.
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));

    const aRow = inserted.find((r) => r.label === "GET act_A/insights");
    const bRow = inserted.find((r) => r.label === "GET act_B/insights");
    assert.ok(aRow, "handler must insert a card for chain A");
    assert.ok(bRow, "handler must insert a card for chain B");
    assert.equal(aRow!.workspaceId, "ws-A", "chain A's card must be scoped to ws-A");
    assert.equal(bRow!.workspaceId, "ws-B", "chain B's card must be scoped to ws-B");
    assert.ok(aRow!.dedupeKey.includes("ws-A"));
    assert.ok(bRow!.dedupeKey.includes("ws-B"));
  } finally {
    registerAppOwnerActionRequiredHandler(null);
  }
});
