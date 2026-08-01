/**
 * Pins the `metaIterationRun` app-owner-action-required catch branch: the
 * shared `escalateAppOwnerActionRequired` SDK is called with THIS
 * invocation's `event.data.workspace_id`, never a module-global or
 * AsyncLocalStorage scope, so two overlapping `meta/iteration-run` publishes
 * for different workspaces cannot cross-contaminate each other's
 * service-role notification writes
 * (docs/brain/specs/meta-iteration-run-app-owner-scope-isolation.md Phase 1).
 *
 * The predicate + escalate helper live in a sibling module
 * ([[./meta-performance-app-owner-action]]) so the isolation invariant is
 * unit-testable without dragging the Inngest sink through its transitive
 * control-tower ↔ registered-functions cycle (a TDZ on `metaSyncPerformance`).
 *
 * Run:
 *   npx tsx --test src/lib/inngest/meta-performance.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isAppOwnerActionRequiredError,
  escalateAppOwnerActionForIterationRun,
} from "./meta-performance-app-owner-action";
import type { EscalateAppOwnerActionRequiredInput } from "@/lib/meta/app-owner-action-escalation";

const SCOPE_A = { workspaceId: "ws-A", adAccountId: "uuid-A" };
const SCOPE_B = { workspaceId: "ws-B", adAccountId: "uuid-B" };

function taggedError(): Error {
  return Object.assign(
    new Error("meta_400: API access disrupted. Go to the App Dashboard and complete Data Use Checkup."),
    { metaClass: "app_owner_action_required", httpStatus: 400 },
  );
}

test("isAppOwnerActionRequiredError — TAGGED Data Use Checkup class is handled", () => {
  const err = Object.assign(new Error("meta_400: app is currently unavailable"), {
    metaClass: "app_owner_action_required",
    httpStatus: 400,
  });
  assert.equal(isAppOwnerActionRequiredError(err), true);
});

test("isAppOwnerActionRequiredError — CONTROL: untagged Meta 500 rethrows (predicate false)", () => {
  assert.equal(isAppOwnerActionRequiredError(new Error("graph 500 — internal server error")), false);
});

test("isAppOwnerActionRequiredError — CONTROL: a different metaClass (permanent) rethrows", () => {
  const err = Object.assign(new Error("permanent api removed"), { metaClass: "permanent_api_removed" });
  assert.equal(isAppOwnerActionRequiredError(err), false);
});

test("isAppOwnerActionRequiredError — CONTROL: null / undefined / string / plain-object rethrow", () => {
  assert.equal(isAppOwnerActionRequiredError(null), false);
  assert.equal(isAppOwnerActionRequiredError(undefined), false);
  assert.equal(isAppOwnerActionRequiredError("boom"), false);
  assert.equal(isAppOwnerActionRequiredError({}), false);
});

test("escalateAppOwnerActionForIterationRun — escalates against THIS invocation's workspaceId with a label naming the ad account", async () => {
  const seen: Array<{ workspaceId: string; label: string; status: number; affected?: string[] }> = [];
  const fakeEscalate = async (
    _admin: unknown,
    input: EscalateAppOwnerActionRequiredInput,
  ) => {
    seen.push({
      workspaceId: input.workspaceId,
      label: input.label,
      status: input.status,
      affected: input.affectedAdAccountIds,
    });
    return { emitted: true };
  };
  await escalateAppOwnerActionForIterationRun({} as never, taggedError(), SCOPE_A, fakeEscalate as never);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].workspaceId, SCOPE_A.workspaceId);
  assert.equal(seen[0].status, 400);
  assert.deepEqual(seen[0].affected, [SCOPE_A.adAccountId]);
  assert.ok(
    seen[0].label.includes(SCOPE_A.adAccountId),
    `label ${seen[0].label} should name the affected ad account`,
  );
});

test("escalateAppOwnerActionForIterationRun — GraphError.httpStatus is preserved when present, defaults to 400 when absent", async () => {
  const seen: Array<{ status: number }> = [];
  const fakeEscalate = async (
    _admin: unknown,
    input: EscalateAppOwnerActionRequiredInput,
  ) => {
    seen.push({ status: input.status });
    return { emitted: true };
  };
  const errWithStatus = Object.assign(new Error("400"), {
    metaClass: "app_owner_action_required",
    httpStatus: 400,
  });
  const errWithoutStatus = Object.assign(new Error("no status"), {
    metaClass: "app_owner_action_required",
  });
  await escalateAppOwnerActionForIterationRun({} as never, errWithStatus, SCOPE_A, fakeEscalate as never);
  await escalateAppOwnerActionForIterationRun({} as never, errWithoutStatus, SCOPE_A, fakeEscalate as never);
  assert.equal(seen[0].status, 400);
  assert.equal(seen[1].status, 400);
});

test("escalateAppOwnerActionForIterationRun — two overlapping invocations from DIFFERENT workspaces each escalate only against their own workspace (isolation invariant)", async () => {
  // The catch block in `metaIterationRun` binds `workspaceId` as a local
  // variable from `event.data.workspace_id` and passes it as an explicit
  // argument here. Running two handlers CONCURRENTLY with interleaved awaits
  // must never leak workspace A's id into workspace B's escalation input
  // (regression: the module-global `setCurrentAppOwnerActionWorkspaceScope`
  // pattern raced on concurrent Inngest publishes and booked cards against
  // the sibling workspace).
  const perAdminWrites = new Map<string, string[]>();
  const makeEscalate = (adminId: string) => async (
    _admin: unknown,
    input: EscalateAppOwnerActionRequiredInput,
  ) => {
    // Force interleaving: yield the event loop before recording so the two
    // in-flight handlers overlap for a real tick.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const bucket = perAdminWrites.get(adminId) ?? [];
    bucket.push(input.workspaceId);
    perAdminWrites.set(adminId, bucket);
    return { emitted: true };
  };
  const adminA = { id: "admin-A" };
  const adminB = { id: "admin-B" };
  await Promise.all([
    escalateAppOwnerActionForIterationRun(adminA as never, taggedError(), SCOPE_A, makeEscalate("admin-A") as never),
    escalateAppOwnerActionForIterationRun(adminB as never, taggedError(), SCOPE_B, makeEscalate("admin-B") as never),
  ]);
  assert.deepEqual(perAdminWrites.get("admin-A"), [SCOPE_A.workspaceId]);
  assert.deepEqual(perAdminWrites.get("admin-B"), [SCOPE_B.workspaceId]);
});

test("meta-performance.ts does NOT import setCurrentAppOwnerActionWorkspaceScope or installDefaultAppOwnerActionEscalationHandler (spec Phase 1 invariant)", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const src = await fs.readFile(
    path.resolve(process.cwd(), "src/lib/inngest/meta-performance.ts"),
    "utf8",
  );
  assert.equal(
    src.includes("setCurrentAppOwnerActionWorkspaceScope"),
    false,
    "metaIterationRun must not rely on the retired module-global scope setter",
  );
  assert.equal(
    src.includes("installDefaultAppOwnerActionEscalationHandler"),
    false,
    "metaIterationRun must not install a process-global escalation handler",
  );
  assert.equal(
    src.includes("runWithAppOwnerActionWorkspaceScope"),
    false,
    "metaIterationRun must not depend on the AsyncLocalStorage scope wrapper — the workspace id is passed explicitly from event.data",
  );
});
