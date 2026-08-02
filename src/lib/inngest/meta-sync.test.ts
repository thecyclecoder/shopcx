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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

test("step-scoped invariant — on a tagged Data Use Checkup error the sync-spend step body contains + returns the fingerprint WITHOUT throwing (blocks the Inngest failure-feed leak)", async () => {
  // The prior bug caught OUTSIDE step.run: the step body itself still threw,
  // Inngest exhausted retries: 2, fired `inngest/function.failed`, and
  // inngest-failure-capture flooded the Control Tower error feed with
  // ~1 signature per active ad account per daily cron (leak signature
  // inngest:bf59b5ccb1252b4d). The proven fix (mirror today-sync.ts) is to
  // catch INSIDE the step body so the step returns cleanly. This test pins
  // the semantic invariant of that shape: given the tagged error, the step
  // body must escalate exactly once against THIS invocation's workspaceId
  // AND return the stable fingerprint WITHOUT throwing.
  const seen: EscalateAppOwnerActionRequiredInput[] = [];
  const fakeEscalate = async (
    _admin: unknown,
    input: EscalateAppOwnerActionRequiredInput,
  ) => {
    seen.push(input);
    return { emitted: true };
  };
  const failingSyncFn = async () => {
    throw taggedError();
  };
  // Mirrors the fix's actual step body shape (see src/lib/inngest/meta-sync.ts
  // `step.run("sync-spend", ...)`): try the Meta sync, on throw delegate to
  // handleMetaSyncSpendError, return the fingerprint from within the step.
  const stepBody = async () => {
    try {
      await failingSyncFn();
      return { status: "complete" as const };
    } catch (err) {
      return await handleMetaSyncSpendError(
        {} as never,
        err,
        SCOPE_A,
        fakeEscalate as never,
      );
    }
  };
  const result = await stepBody();
  // Must NOT throw — a throw here is what the old outer-catch shape let happen
  // (step exhaustion → inngest/function.failed → Control Tower leak).
  assert.equal(
    (result as { status: string }).status,
    META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED,
    "step body must return the stable fingerprint, never throw",
  );
  assert.equal(seen.length, 1, "exactly one CEO escalation card is booked");
  assert.equal(
    seen[0].workspaceId,
    SCOPE_A.workspaceId,
    "escalation binds THIS invocation's workspaceId (per-workspace isolation)",
  );
});

test("source-scan invariant — `handleMetaSyncSpendError` is called INSIDE the `sync-spend` step.run body (no outer try/catch around step.run)", () => {
  // Prevents regressions to the outer-catch shape that leaked
  // `inngest/function.failed` on every retry-exhausted Data Use Checkup 400.
  // The fingerprint substring the deploy-gate/spec-runner greps for.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "meta-sync.ts"), "utf8");

  const openIdx = src.indexOf('step.run("sync-spend"');
  assert.notEqual(openIdx, -1, 'expected a step.run("sync-spend", ...) call in meta-sync.ts');

  // Find the balanced end of the step.run callback body (from the first `{`
  // after the step.run open paren to the matching `}`).
  const braceStart = src.indexOf("{", openIdx);
  assert.notEqual(braceStart, -1, "expected a `{` opening the step.run callback body");
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  assert.notEqual(braceEnd, -1, "expected a matching `}` closing the step.run callback body");

  const stepBody = src.slice(braceStart, braceEnd + 1);
  assert.ok(
    stepBody.includes("handleMetaSyncSpendError("),
    "handleMetaSyncSpendError MUST be called INSIDE the sync-spend step.run body — the containment-inside-step invariant that stops the inngest/function.failed leak",
  );

  // The outer try/catch that wrapped step.run("sync-spend") must be gone —
  // check the code IMMEDIATELY before the step.run call is not a `try {`
  // opener that would still let the old shape sneak back in.
  const beforeStepRun = src.slice(Math.max(0, openIdx - 200), openIdx);
  // Allow the word "try" in comments; assert there is no `try {` opener
  // in the last 200 chars leading into step.run("sync-spend".
  const tryOpenerMatch = beforeStepRun.match(/\btry\s*\{[^}]*await\s+$/);
  assert.equal(
    tryOpenerMatch,
    null,
    "the outer try/catch around step.run(\"sync-spend\") must be removed — containment lives INSIDE the step",
  );
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
