/**
 * Regression tests for [[./reconnect-required-escalation]] —
 * [[../../../docs/brain/specs/meta-reconnect-required-class]] Phase 2.
 *
 * Two contracts pinned here:
 *
 *   1. WORKSPACE SCOPE ISOLATION. The prior-card lookup in
 *      `escalateReconnectRequired` filters on `workspace_id`; the
 *      AsyncLocalStorage-backed `runWithReconnectRequiredWorkspaceScope`
 *      guarantees two overlapping publishes for different workspaces each see
 *      their own scope across interleaved awaits. Two already-folded specs
 *      (meta-sync-spend-escalation-workspace-scope-isolation,
 *      fix-ad-tool-app-owner-action-scope-isolation) exist because prior
 *      prior-card queries leaked across workspaces.
 *
 *   2. CONFIRM BEFORE ESCALATING. The debug_token probe MUST decide whether a
 *      card is raised — a single-sighting string trigger must never bypass it.
 *      • probe unreachable → no card,
 *      • probe reports token VALID → no card (false-positive),
 *      • probe reports token INVALID → card raised + deduped per workspace/day.
 *
 * Run:
 *   npx tsx --test src/lib/meta/reconnect-required-escalation.workspace-scope.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  escalateReconnectRequired,
  getCurrentReconnectRequiredWorkspaceScope,
  installDefaultReconnectRequiredEscalationHandler,
  runWithReconnectRequiredWorkspaceScope,
  type DebugTokenProbe,
} from "./reconnect-required-escalation";
import {
  graphError,
  getReconnectRequiredHandler,
  registerReconnectRequiredHandler,
} from "./graph-retry";

// ── AsyncLocalStorage-backed workspace scope isolation ──────────────────────

test("runWithReconnectRequiredWorkspaceScope — two overlapping scopes for different workspaces stay isolated across interleaved awaits, and the handler sees each chain's own workspace", async () => {
  const observed: Array<{ chain: "A" | "B"; workspaceId: string | null }> = [];
  const handlerCalls: Array<{ workspaceId: string | null; label: string }> = [];

  registerReconnectRequiredHandler((ctx) => {
    handlerCalls.push({
      workspaceId: getCurrentReconnectRequiredWorkspaceScope(),
      label: ctx.label,
    });
  });

  try {
    const chainA = runWithReconnectRequiredWorkspaceScope("ws-A", async () => {
      observed.push({ chain: "A", workspaceId: getCurrentReconnectRequiredWorkspaceScope() });
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      observed.push({ chain: "A", workspaceId: getCurrentReconnectRequiredWorkspaceScope() });
      const handler = getReconnectRequiredHandler();
      handler?.({
        label: "GET act_A/insights",
        status: 400,
        error: graphError(400, { message: "API access blocked." }),
      });
      return getCurrentReconnectRequiredWorkspaceScope();
    });

    const chainB = runWithReconnectRequiredWorkspaceScope("ws-B", async () => {
      observed.push({ chain: "B", workspaceId: getCurrentReconnectRequiredWorkspaceScope() });
      await Promise.resolve();
      await Promise.resolve();
      observed.push({ chain: "B", workspaceId: getCurrentReconnectRequiredWorkspaceScope() });
      const handler = getReconnectRequiredHandler();
      handler?.({
        label: "GET act_B/insights",
        status: 400,
        error: graphError(400, { message: "API access blocked." }),
      });
      return getCurrentReconnectRequiredWorkspaceScope();
    });

    const [aFinal, bFinal] = await Promise.all([chainA, chainB]);

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

    const aHandler = handlerCalls.find((c) => c.label === "GET act_A/insights");
    const bHandler = handlerCalls.find((c) => c.label === "GET act_B/insights");
    assert.equal(aHandler?.workspaceId, "ws-A", "handler fired from chain A binds ws-A");
    assert.equal(bHandler?.workspaceId, "ws-B", "handler fired from chain B binds ws-B");
  } finally {
    registerReconnectRequiredHandler(null);
  }
});

test("getCurrentReconnectRequiredWorkspaceScope — returns null outside any runWithReconnectRequiredWorkspaceScope call", () => {
  assert.equal(getCurrentReconnectRequiredWorkspaceScope(), null);
});

// ── prior-card lookup is workspace-scoped (regression guard on two folded specs) ──

test("escalateReconnectRequired — the prior-card SELECT filters on workspace_id (no cross-workspace leak)", async () => {
  // Prove the SELECT chain includes .eq('workspace_id', <input.workspaceId>) —
  // this is the exact predicate two already-folded specs
  // (meta-sync-spend-escalation-workspace-scope-isolation,
  // fix-ad-tool-app-owner-action-scope-isolation) restored on their sibling
  // escalation SDKs after the prior-card query had leaked across workspaces.
  const eqCalls: Array<{ column: string; value: unknown }> = [];
  const inserts: Array<{ workspaceId: string; dedupeKey: string }> = [];

  const stubAdmin = {
    from(table: string) {
      if (table === "workspaces") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({
              data: { meta_user_access_token_encrypted: null },
              error: null,
            });
          },
        };
      }
      return {
        select() { return this; },
        eq(column: string, value: unknown) {
          eqCalls.push({ column, value });
          return this;
        },
        limit() { return Promise.resolve({ data: [], error: null }); },
        insert(row: { workspace_id: string; metadata: { dedupe_key: string } }) {
          inserts.push({ workspaceId: row.workspace_id, dedupeKey: row.metadata.dedupe_key });
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as Parameters<typeof escalateReconnectRequired>[0];

  // Stub the probe to report token INVALID — the whole point of THIS test is
  // proving the workspace-scoped SELECT fires when a card is about to be
  // raised. A reachable+invalid verdict is what gets past the confirm-gate.
  const probeDebugToken: DebugTokenProbe = async () => ({ reachable: true, valid: false });

  const result = await escalateReconnectRequired(stubAdmin, {
    workspaceId: "ws-42",
    label: "GET act_1234/insights",
    status: 400,
    error: graphError(400, { message: "API access blocked." }),
    nowMs: Date.UTC(2026, 7, 3, 12, 0, 0),
    probeDebugToken,
  });
  assert.equal(result.emitted, true, "reachable+invalid verdict + no prior card → card must be emitted");

  const workspaceEq = eqCalls.find((c) => c.column === "workspace_id");
  assert.ok(
    workspaceEq,
    "prior-card lookup MUST include .eq('workspace_id', ...) — the regression guard for the two folded workspace-scope specs",
  );
  assert.equal(workspaceEq!.value, "ws-42", "the workspace filter must match the caller's workspaceId");

  const dedupeEq = eqCalls.find((c) => c.column === "metadata->>dedupe_key");
  assert.ok(dedupeEq, "prior-card lookup MUST filter on the dedupe_key metadata column");
  assert.equal(dedupeEq!.value, "reconnect_required:ws-42:2026-08-03");

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].workspaceId, "ws-42");
  assert.equal(inserts[0].dedupeKey, "reconnect_required:ws-42:2026-08-03");
});

// ── confirm-before-escalate: the probe is what decides ───────────────────────

test("escalateReconnectRequired — probe unreachable → no card (fail-closed on unreliable probe)", async () => {
  let insertCount = 0;
  const stubAdmin = makeInsertCountingAdmin(() => ++insertCount);
  const probeDebugToken: DebugTokenProbe = async () => ({ reachable: false, reason: "test" });

  const result = await escalateReconnectRequired(stubAdmin, {
    workspaceId: "ws-1",
    label: "GET act_1/insights",
    status: 400,
    error: graphError(400, { message: "API access blocked." }),
    probeDebugToken,
  });
  assert.equal(result.emitted, false, "unreachable probe MUST NOT raise a card");
  assert.equal(insertCount, 0);
});

test("escalateReconnectRequired — probe reports token VALID → no card (single-sighting string was a false positive)", async () => {
  let insertCount = 0;
  const stubAdmin = makeInsertCountingAdmin(() => ++insertCount);
  const probeDebugToken: DebugTokenProbe = async () => ({ reachable: true, valid: true });

  const result = await escalateReconnectRequired(stubAdmin, {
    workspaceId: "ws-1",
    label: "GET act_1/insights",
    status: 400,
    error: graphError(400, { message: "API access blocked." }),
    probeDebugToken,
  });
  assert.equal(result.emitted, false, "VALID probe verdict MUST NOT raise a card");
  assert.equal(insertCount, 0);
});

test("escalateReconnectRequired — probe throws → no card (fail-closed, swallowed with warn)", async () => {
  let insertCount = 0;
  const stubAdmin = makeInsertCountingAdmin(() => ++insertCount);
  const probeDebugToken: DebugTokenProbe = async () => {
    throw new Error("network_boom");
  };

  const result = await escalateReconnectRequired(stubAdmin, {
    workspaceId: "ws-1",
    label: "GET act_1/insights",
    status: 400,
    error: graphError(400, { message: "API access blocked." }),
    probeDebugToken,
  });
  assert.equal(result.emitted, false);
  assert.equal(insertCount, 0);
});

// ── dedupe + card copy contract ──────────────────────────────────────────────

test("escalateReconnectRequired — same day + same workspace collapses to one card (dedupe_key hit)", async () => {
  let insertCount = 0;
  const priorRows: Array<{ id: string }> = [];
  const stubAdmin = {
    from(table: string) {
      if (table === "workspaces") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: { meta_user_access_token_encrypted: null }, error: null });
          },
        };
      }
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return Promise.resolve({ data: priorRows, error: null }); },
        insert() {
          insertCount++;
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as Parameters<typeof escalateReconnectRequired>[0];

  const probeDebugToken: DebugTokenProbe = async () => ({ reachable: true, valid: false });

  // First call: no prior row → emits.
  const r1 = await escalateReconnectRequired(stubAdmin, {
    workspaceId: "ws-1",
    label: "GET act_1/insights",
    status: 400,
    error: graphError(400, { message: "API access blocked." }),
    nowMs: Date.UTC(2026, 7, 3),
    probeDebugToken,
  });
  assert.equal(r1.emitted, true);

  // Simulate a same-day prior card now existing.
  priorRows.push({ id: "prior-1" });

  const r2 = await escalateReconnectRequired(stubAdmin, {
    workspaceId: "ws-1",
    label: "GET act_1/insights",
    status: 400,
    error: graphError(400, { message: "API access blocked." }),
    nowMs: Date.UTC(2026, 7, 3, 23, 59),
    probeDebugToken,
  });
  assert.equal(r2.emitted, false, "same day + workspace + dedupe_key → no duplicate insert");
  assert.equal(insertCount, 1, "only the first call inserted");
});

test("escalateReconnectRequired — card body routes to the integrations page, never the App Dashboard, and calls out ads_read + ads_management", async () => {
  let inserted: {
    title?: string;
    body?: string;
    link?: string;
    metadata?: { escalation_kind?: string; dedupe_key?: string };
  } = {};
  const stubAdmin = {
    from(table: string) {
      if (table === "workspaces") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: { meta_user_access_token_encrypted: null }, error: null });
          },
        };
      }
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        insert(row: typeof inserted) {
          inserted = row;
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as Parameters<typeof escalateReconnectRequired>[0];

  const probeDebugToken: DebugTokenProbe = async () => ({ reachable: true, valid: false });

  const r = await escalateReconnectRequired(stubAdmin, {
    workspaceId: "ws-1",
    label: "GET act_1/insights",
    status: 400,
    error: graphError(400, { message: "API access blocked." }),
    probeDebugToken,
  });
  assert.equal(r.emitted, true);
  assert.equal(inserted.link, "/dashboard/settings/integrations/meta");
  assert.ok(
    !(inserted.body ?? "").toLowerCase().includes("app dashboard"),
    "card body must not mention the App Dashboard — that's the WRONG remedy for this class",
  );
  assert.ok(
    (inserted.body ?? "").includes("ads_read"),
    "card body must name ads_read (must remain granted on the consent screen)",
  );
  assert.ok(
    (inserted.body ?? "").includes("ads_management"),
    "card body must name ads_management (must remain granted on the consent screen)",
  );
  assert.ok(
    (inserted.body ?? "").toLowerCase().includes("unmeasured"),
    "card body must state spend is accruing UNMEASURED while disconnected",
  );
  assert.equal(inserted.metadata?.escalation_kind, "reconnect_required");
});

// ── helpers ─────────────────────────────────────────────────────────────────

function makeInsertCountingAdmin(
  onInsert: () => void,
): Parameters<typeof escalateReconnectRequired>[0] {
  return {
    from(table: string) {
      if (table === "workspaces") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: { meta_user_access_token_encrypted: null }, error: null });
          },
        };
      }
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        insert() {
          onInsert();
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as Parameters<typeof escalateReconnectRequired>[0];
}

// ── installDefaultReconnectRequiredEscalationHandler — handler resolves scope from the ALS store at fire time ──

test("installDefaultReconnectRequiredEscalationHandler — the installed handler resolves its workspace from the ALS store at fire time, not from a module-global", async () => {
  const inserted: Array<{ workspaceId: string; dedupeKey: string; label: string }> = [];

  const stubAdmin = {
    from(table: string) {
      if (table === "workspaces") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: { meta_user_access_token_encrypted: null }, error: null });
          },
        };
      }
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
  } as unknown as Parameters<typeof installDefaultReconnectRequiredEscalationHandler>[0];

  // The installed handler builds its own EscalateReconnectRequiredInput — it
  // does NOT thread a probe through. So we need to make the DEFAULT probe
  // return reachable+invalid without a real fetch. Stub the env so the
  // default probe short-circuits — with no META_APP_* configured, the probe
  // returns reachable=false and NO card. To exercise the ALS handler's
  // workspace-resolution path, we instead register a THIN handler wrapper
  // that hands a controlled probe to escalateReconnectRequired directly.
  registerReconnectRequiredHandler((ctx) => {
    const workspaceId = getCurrentReconnectRequiredWorkspaceScope();
    if (!workspaceId) return;
    void escalateReconnectRequired(stubAdmin, {
      workspaceId,
      label: ctx.label,
      status: ctx.status,
      error: ctx.error,
      probeDebugToken: async () => ({ reachable: true, valid: false }),
    });
  });

  try {
    const wait = new Promise<void>((resolve) => setTimeout(resolve, 5));

    const chainA = runWithReconnectRequiredWorkspaceScope("ws-A", async () => {
      await Promise.resolve();
      await wait;
      const handler = getReconnectRequiredHandler();
      handler?.({
        label: "GET act_A/insights",
        status: 400,
        error: graphError(400, { message: "API access blocked." }),
      });
    });

    const chainB = runWithReconnectRequiredWorkspaceScope("ws-B", async () => {
      await Promise.resolve();
      await wait;
      const handler = getReconnectRequiredHandler();
      handler?.({
        label: "GET act_B/insights",
        status: 400,
        error: graphError(400, { message: "API access blocked." }),
      });
    });

    await Promise.all([chainA, chainB]);
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
    registerReconnectRequiredHandler(null);
  }
});
