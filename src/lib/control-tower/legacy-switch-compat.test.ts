/**
 * Unit tests for the migrate-ad-hoc-kill-switches-to-resolver Phase 1 compat shim.
 *
 *   npx tsx --test src/lib/control-tower/legacy-switch-compat.test.ts
 *
 * Coverage:
 *   1. Union semantics — OFF from either source wins; both ON = ON; legacy attribution wins when
 *      both sources flip.
 *   2. Fail-open — a THROWN legacyFn or resolver call degrades to ON.
 *   3. Per-site fixture — for EACH of the 6 named call sites, flip ONE source (legacy OR resolver)
 *      and expect the site's exported gate to pause (union binds). These use the shim's
 *      `_setResolverForTests` test seam to feed a fixture `KillSwitchMap` without hitting Supabase.
 *
 * The shim's DB-touching path (real `resolveEffectiveSwitch`) is integration-tested against a
 * live pooler via the spec's Phase 2 verification checklist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  readEffectiveOnOff,
  isEffectivelyEnabled,
  _setResolverForTests,
} from "./legacy-switch-compat";
import {
  resolveEffectiveSwitchFromMap,
  type EffectiveSwitch,
  type KillSwitchMap,
  type KillSwitchRow,
} from "./kill-switch-resolver";

// ── Fixture helpers ──────────────────────────────────────────────────────────────

function row(
  node_id: string,
  scope: KillSwitchRow["scope"],
  off_by = "ceo",
  reason: string | null = null,
): KillSwitchRow {
  return { node_id, scope, off_by, off_at: "2026-07-12T00:00:00Z", reason };
}

function mapOf(...rows: KillSwitchRow[]): KillSwitchMap {
  const m = new Map<string, KillSwitchRow>();
  for (const r of rows) m.set(r.node_id, r);
  return m;
}

/** Install a resolver override that reads from `map` via the pure walk. */
function useFixture(map: KillSwitchMap): void {
  _setResolverForTests(async (nodeId: string): Promise<EffectiveSwitch> => {
    return resolveEffectiveSwitchFromMap(nodeId, map);
  });
}

function resetFixture(): void {
  _setResolverForTests(null);
}

// ── Shim semantics ───────────────────────────────────────────────────────────────

test("shim — legacy OFF (returns false) wins and attributes source='legacy' (resolver never consulted)", async () => {
  let resolverCalled = false;
  _setResolverForTests(async () => {
    resolverCalled = true;
    return { off: false };
  });
  try {
    const v = await readEffectiveOnOff("pr-resolve", async () => false);
    assert.deepEqual(v, { off: true, source: "legacy" });
    assert.equal(resolverCalled, false, "resolver must not be called when legacy already OFF");
  } finally {
    resetFixture();
  }
});

test("shim — resolver OFF flips the answer even when legacy is ON (union binds the cascade)", async () => {
  useFixture(mapOf(row("growth", "department", "ceo", "pause growth")));
  try {
    const v = await readEffectiveOnOff("media-buyer", async () => true);
    assert.equal(v.off, true);
    if (v.off) {
      assert.equal(v.source, "resolver");
      assert.equal(v.offBy, "growth");
      assert.equal(v.reason, "pause growth");
    }
  } finally {
    resetFixture();
  }
});

test("shim — both sources ON keeps the gate open", async () => {
  useFixture(mapOf());
  try {
    const v = await readEffectiveOnOff("media-buyer", async () => true);
    assert.deepEqual(v, { off: false });
  } finally {
    resetFixture();
  }
});

test("shim — legacy `undefined` (column absent) is treated as ON; falls through to the resolver", async () => {
  useFixture(mapOf(row("platform", "department")));
  try {
    const v = await readEffectiveOnOff("pr-resolve", async () => undefined);
    assert.equal(v.off, true);
    if (v.off) assert.equal(v.source, "resolver");
  } finally {
    resetFixture();
  }
});

test("shim — a THROWN legacyFn degrades to ON (fail-open); resolver still binds", async () => {
  useFixture(mapOf());
  try {
    const v = await readEffectiveOnOff("pr-resolve", async () => {
      throw new Error("legacy read blew up");
    });
    assert.deepEqual(v, { off: false });
  } finally {
    resetFixture();
  }
});

test("shim — a THROWN resolver degrades to ON (fail-open); a transient blip cannot silently switch a gate OFF", async () => {
  _setResolverForTests(async () => {
    throw new Error("supabase blip");
  });
  try {
    const v = await readEffectiveOnOff("pr-resolve", async () => true);
    assert.deepEqual(v, { off: false });
  } finally {
    resetFixture();
  }
});

test("shim — legacy OFF wins attribution when BOTH sources are OFF (audit surfaces the pre-existing pause)", async () => {
  useFixture(mapOf(row("growth", "department")));
  try {
    const v = await readEffectiveOnOff("media-buyer", async () => false);
    assert.deepEqual(v, { off: true, source: "legacy" });
  } finally {
    resetFixture();
  }
});

test("shim — isEffectivelyEnabled collapses to a boolean (true=on, false=paused)", async () => {
  useFixture(mapOf(row("growth", "department")));
  try {
    // Legacy=true, resolver OFF → collapse to false.
    assert.equal(await isEffectivelyEnabled("media-buyer", async () => true), false);
    // Legacy=false → false.
    resetFixture();
    useFixture(mapOf());
    assert.equal(await isEffectivelyEnabled("media-buyer", async () => false), false);
    // Both ON → true.
    assert.equal(await isEffectivelyEnabled("media-buyer", async () => true), true);
  } finally {
    resetFixture();
  }
});

// ── Per-site fixtures — flip ONE source, expect the site's gate to pause ─────────
//
// Each site test constructs an admin-client stub returning a row where the LEGACY column
// signals ON (so we can prove the RESOLVER flip binds), then constructs one where the LEGACY
// signals OFF with the resolver ON (proves the LEGACY still binds). Both directions of the
// union must pause the gate.

test("site — github-pr-resolve isAutoMergeEnabled: LEGACY OFF pauses (auto_merge_enabled=false, resolver clear)", async () => {
  useFixture(mapOf()); // resolver ON
  try {
    const { isAutoMergeEnabled } = await import("@/lib/github-pr-resolve");
    const admin = {
      // Both resolveBuildWorkspaceId and the workspaces read run against this stub.
      from(_table: string) {
        return makeReturning({ auto_merge_enabled: false, id: WORKSPACE_ID, slug: "build-console" });
      },
    } as unknown as Parameters<typeof isAutoMergeEnabled>[0];
    const enabled = await isAutoMergeEnabled(admin);
    assert.equal(enabled, false, "legacy=false must pause auto-merge (Phase 1 verification #2)");
  } finally {
    resetFixture();
  }
});

test("site — github-pr-resolve isAutoMergeEnabled: RESOLVER OFF pauses (auto_merge_enabled=true, `platform` dept-off)", async () => {
  useFixture(mapOf(row("platform", "department", "ceo", "pause platform")));
  try {
    const { isAutoMergeEnabled } = await import("@/lib/github-pr-resolve");
    const admin = {
      from(_table: string) {
        return makeReturning({ auto_merge_enabled: true, id: WORKSPACE_ID, slug: "build-console" });
      },
    } as unknown as Parameters<typeof isAutoMergeEnabled>[0];
    const enabled = await isAutoMergeEnabled(admin);
    assert.equal(enabled, false, "resolver OFF must pause auto-merge (Phase 1 verification #3)");
  } finally {
    resetFixture();
  }
});

test("site — spec-test-runs isAutoFoldEnabled: LEGACY OFF pauses (auto_fold_enabled=false, resolver clear)", async () => {
  useFixture(mapOf());
  try {
    const { isAutoFoldEnabled } = await import("@/lib/spec-test-runs");
    const admin = {
      from(_table: string) {
        return makeReturning({ auto_fold_enabled: false });
      },
    } as unknown as Parameters<typeof isAutoFoldEnabled>[1];
    const enabled = await isAutoFoldEnabled(WORKSPACE_ID, admin);
    assert.equal(enabled, false, "legacy=false must pause auto-fold");
  } finally {
    resetFixture();
  }
});

test("site — spec-test-runs isAutoFoldEnabled: RESOLVER OFF pauses (auto_fold_enabled=true, `platform` dept-off)", async () => {
  useFixture(mapOf(row("platform", "department")));
  try {
    const { isAutoFoldEnabled } = await import("@/lib/spec-test-runs");
    const admin = {
      from(_table: string) {
        return makeReturning({ auto_fold_enabled: true });
      },
    } as unknown as Parameters<typeof isAutoFoldEnabled>[1];
    const enabled = await isAutoFoldEnabled(WORKSPACE_ID, admin);
    assert.equal(enabled, false, "resolver OFF must pause auto-fold");
  } finally {
    resetFixture();
  }
});

test("site — meta/execution isMetaExecutionAdapterEnabled: LEGACY OFF (adapter not shipped) pauses", async () => {
  useFixture(mapOf());
  try {
    const { isMetaExecutionAdapterEnabled } = await import("@/lib/meta/execution");
    // `replenish_creative` is intentionally NOT in ENABLED_ADAPTERS (legacy=false).
    const enabled = await isMetaExecutionAdapterEnabled("replenish_creative");
    assert.equal(enabled, false, "legacy=false (unshipped adapter) must pause execution");
  } finally {
    resetFixture();
  }
});

test("site — meta/execution isMetaExecutionAdapterEnabled: RESOLVER OFF pauses a shipped adapter", async () => {
  useFixture(mapOf(row("growth", "department")));
  try {
    const { isMetaExecutionAdapterEnabled } = await import("@/lib/meta/execution");
    // `pause` IS in ENABLED_ADAPTERS (legacy=true) — the union must still return false because
    // the growth cascade is OFF.
    const enabled = await isMetaExecutionAdapterEnabled("pause");
    assert.equal(enabled, false, "resolver OFF must pause a shipped adapter");
  } finally {
    resetFixture();
  }
});

test("site — meta/recommendation-execute isMetaRecommendationAdapterEnabled: LEGACY OFF pauses", async () => {
  useFixture(mapOf());
  try {
    const { isMetaRecommendationAdapterEnabled } = await import(
      "@/lib/meta/recommendation-execute"
    );
    // `test_benefit_angle` is not in ENABLED_ADAPTERS (legacy=false).
    const enabled = await isMetaRecommendationAdapterEnabled("test_benefit_angle");
    assert.equal(enabled, false, "legacy=false (unshipped adapter) must pause");
  } finally {
    resetFixture();
  }
});

test("site — meta/recommendation-execute isMetaRecommendationAdapterEnabled: RESOLVER OFF pauses a shipped adapter", async () => {
  useFixture(mapOf(row("growth", "department")));
  try {
    const { isMetaRecommendationAdapterEnabled } = await import(
      "@/lib/meta/recommendation-execute"
    );
    // `new_static_adset` IS in ENABLED_ADAPTERS (legacy=true) — the union must still return false.
    const enabled = await isMetaRecommendationAdapterEnabled("new_static_adset");
    assert.equal(enabled, false, "resolver OFF must pause a shipped recommendation adapter");
  } finally {
    resetFixture();
  }
});

test("site — media-buyer arming-gate runMediaBuyerArmingGate: RESOLVER OFF short-circuits with kill_switch_cascade_off", async () => {
  useFixture(mapOf(row("growth", "department", "ceo", "growth paused for review")));
  try {
    const { runMediaBuyerArmingGate } = await import("@/lib/media-buyer/arming-gate");
    // Admin stub — arming gate short-circuits BEFORE any DB read on the cascade-off path, so a
    // "throws on any call" stub proves the resolver-off route bypasses shadowReviews / trust
    // snapshots / blended CAC:LTV loads entirely.
    const admin = {
      from() {
        throw new Error("arming gate must short-circuit on cascade OFF — no DB reads expected");
      },
    } as unknown as Parameters<typeof runMediaBuyerArmingGate>[0];
    const result = await runMediaBuyerArmingGate(admin, {
      workspaceId: WORKSPACE_ID,
      metaAdAccountId: null,
      now: new Date("2026-07-12T00:00:00Z"),
    });
    assert.equal(result.status, "denied");
    assert.equal(result.authorizationId, null);
    assert.equal(result.reasons.length, 1);
    assert.equal(result.reasons[0].code, "kill_switch_cascade_off");
    assert.match(result.reasons[0].detail, /source=resolver/);
    assert.match(result.reasons[0].detail, /offBy=growth/);
  } finally {
    resetFixture();
  }
});

test("site — voice-angle-approve executeApproveVoiceAngle: RESOLVER OFF refuses BEFORE the angle lookup", async () => {
  useFixture(mapOf(row("growth", "department")));
  try {
    const { executeApproveVoiceAngle } = await import("@/lib/ads/voice-angle-approve");
    // Admin stub — voice-angle executor short-circuits on cascade OFF before any DB call.
    const admin = {
      from() {
        throw new Error("voice-angle executor must short-circuit on cascade OFF — no DB reads expected");
      },
    } as unknown as Parameters<typeof executeApproveVoiceAngle>[0];
    const result = await executeApproveVoiceAngle(admin, {
      workspaceId: WORKSPACE_ID,
      specSlug: "test-spec",
      payload: {
        angle_id: "00000000-0000-0000-0000-000000000000",
        product_id: "00000000-0000-0000-0000-000000000001",
        source_signal_counts: { positive: 1, objection: 1, use_case: 1 },
        archetype: "testimonial",
      },
      deps: {
        sendInngest: async () => ({}),
        recordActivity: async () => ({}),
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /^kill_switch_off:resolver:growth/);
  } finally {
    resetFixture();
  }
});

// ── Test helpers ─────────────────────────────────────────────────────────────────

const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000ff";

/**
 * Minimal chainable Supabase-query stub — enough for the site fns' `.from(...).select(...)
 * .eq(...).maybeSingle()` and `.from(...).select(...).eq(...).eq(...).maybeSingle()` shapes.
 * Every terminal returns `{ data, error: null }`. The chain also supports the `.from("build_workspace")` /
 * `.from("workspaces")` reads the auto-merge / auto-fold gates issue.
 */
function makeReturning(data: unknown): unknown {
  const terminal = { data, error: null };
  const chain: Record<string, unknown> = {
    select() { return chain; },
    eq() { return chain; },
    order() { return chain; },
    limit() { return chain; },
    single() { return Promise.resolve(terminal); },
    maybeSingle() { return Promise.resolve(terminal); },
    then(resolve: (v: unknown) => unknown) { return Promise.resolve(terminal).then(resolve); },
  };
  return chain;
}
