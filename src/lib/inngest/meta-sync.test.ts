/**
 * Pins the `metaSyncSpend` error-branch classifier + workspace-scope
 * isolation (docs/brain/specs/
 * meta-sync-spend-escalation-workspace-scope-isolation.md Phase 1).
 *
 * Meta's Data Use Checkup 400 is a HUMAN-blocked state that persists until
 * the app owner clears it in the App Dashboard. metaSyncSpend must:
 *   (1) contain the tagged error as a stable human-blocked result rather
 *       than let it become an unhandled crash that floods Inngest,
 *   (2) book the deduped CEO card against THIS invocation's `workspace_id`
 *       — never a module-global mutable scope, so two overlapping runs from
 *       different workspaces cannot cross-contaminate each other's
 *       service-role notification writes,
 *   (3) still throw on an untagged Meta 400 so real fatals surface in the
 *       Inngest failure feed.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/meta-sync.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED,
  classifyMetaSyncSpendError,
  handleMetaSyncSpendError,
} from "./meta-sync";
import type { EscalateAppOwnerActionRequiredInput } from "@/lib/meta/app-owner-action-escalation";

const SCOPE_A = {
  workspaceId: "ws-A",
  adAccountId: "uuid-A",
  metaAccountId: "act-A",
};
const SCOPE_B = {
  workspaceId: "ws-B",
  adAccountId: "uuid-B",
  metaAccountId: "act-B",
};

function taggedError(): Error {
  return Object.assign(
    new Error("meta_400: API access disrupted. Go to the App Dashboard and complete Data Use Checkup."),
    { metaClass: "app_owner_action_required", httpStatus: 400 },
  );
}

test("classifyMetaSyncSpendError — Data Use Checkup tag is contained as the stable human-blocked fingerprint", () => {
  const err = taggedError();
  assert.deepEqual(classifyMetaSyncSpendError(err, SCOPE_A), {
    status: META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED,
    workspaceId: SCOPE_A.workspaceId,
    adAccountId: SCOPE_A.adAccountId,
    metaAccountId: SCOPE_A.metaAccountId,
  });
});

test("classifyMetaSyncSpendError — plain fatal Meta 400 (no tag) still propagates (returns null → caller rethrows)", () => {
  const err = new Error("meta_400: Invalid parameter");
  assert.equal(classifyMetaSyncSpendError(err, SCOPE_A), null);
});

test("classifyMetaSyncSpendError — unrelated metaClass does not match", () => {
  const err = Object.assign(new Error("meta_400: Feature no longer supported"), {
    metaClass: "permanent_api_removed",
  });
  assert.equal(classifyMetaSyncSpendError(err, SCOPE_A), null);
});

test("classifyMetaSyncSpendError — null / non-Error input is safe (no throw, returns null)", () => {
  assert.equal(classifyMetaSyncSpendError(null, SCOPE_A), null);
  assert.equal(classifyMetaSyncSpendError("some string", SCOPE_A), null);
});

test("META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED — stable fingerprint literal (grepable pin)", () => {
  assert.equal(
    META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED,
    "meta_sync_spend_app_owner_action_required",
  );
});

test("handleMetaSyncSpendError — tagged error returns the fingerprint AND explicitly escalates against THIS invocation's workspaceId", async () => {
  const seen: Array<{ workspaceId: string; label: string; adAccountIds?: string[] }> = [];
  const fakeEscalate = async (
    _admin: unknown,
    input: EscalateAppOwnerActionRequiredInput,
  ) => {
    seen.push({
      workspaceId: input.workspaceId,
      label: input.label,
      adAccountIds: input.affectedAdAccountIds,
    });
    return { emitted: true };
  };
  const result = await handleMetaSyncSpendError(
    {} as never,
    taggedError(),
    SCOPE_A,
    fakeEscalate as never,
  );
  assert.deepEqual(result, {
    status: META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED,
    workspaceId: SCOPE_A.workspaceId,
    adAccountId: SCOPE_A.adAccountId,
    metaAccountId: SCOPE_A.metaAccountId,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].workspaceId, SCOPE_A.workspaceId);
  assert.deepEqual(seen[0].adAccountIds, [SCOPE_A.metaAccountId]);
  assert.ok(
    seen[0].label.includes(SCOPE_A.metaAccountId),
    `label ${seen[0].label} should name the affected ad account`,
  );
});

test("handleMetaSyncSpendError — untagged Meta 400 still throws (regression: Inngest failure feed keeps surfacing real fatals)", async () => {
  const seen: Array<EscalateAppOwnerActionRequiredInput> = [];
  const fakeEscalate = async (
    _admin: unknown,
    input: EscalateAppOwnerActionRequiredInput,
  ) => {
    seen.push(input);
    return { emitted: true };
  };
  const untagged = new Error("meta_400: Invalid parameter");
  await assert.rejects(
    () =>
      handleMetaSyncSpendError({} as never, untagged, SCOPE_A, fakeEscalate as never),
    (rejected: unknown) => rejected === untagged,
  );
  assert.equal(seen.length, 0, "no escalation card is booked for a plain fatal");
});

test("handleMetaSyncSpendError — two overlapping invocations from DIFFERENT workspaces each write only to their own workspace (isolation invariant)", async () => {
  // Each invocation records its escalation into a per-workspace admin
  // sentinel. Because the workspace id flows through a local variable in the
  // catch — never a module-global — running the two handlers CONCURRENTLY
  // with interleaved awaits must never cross a notification write from one
  // workspace onto the other's admin client.
  const perWorkspaceWrites = new Map<string, string[]>();
  const makeEscalate = (adminId: string) => async (
    _admin: unknown,
    input: EscalateAppOwnerActionRequiredInput,
  ) => {
    // Force interleaving: yield the event loop before recording so the two
    // in-flight handlers overlap for a real tick.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const bucket = perWorkspaceWrites.get(adminId) ?? [];
    bucket.push(input.workspaceId);
    perWorkspaceWrites.set(adminId, bucket);
    return { emitted: true };
  };
  const adminA = { id: "admin-A" };
  const adminB = { id: "admin-B" };
  await Promise.all([
    handleMetaSyncSpendError(adminA as never, taggedError(), SCOPE_A, makeEscalate("admin-A") as never),
    handleMetaSyncSpendError(adminB as never, taggedError(), SCOPE_B, makeEscalate("admin-B") as never),
  ]);
  assert.deepEqual(perWorkspaceWrites.get("admin-A"), [SCOPE_A.workspaceId]);
  assert.deepEqual(perWorkspaceWrites.get("admin-B"), [SCOPE_B.workspaceId]);
});
