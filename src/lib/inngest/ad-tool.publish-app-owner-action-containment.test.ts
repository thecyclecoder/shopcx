/**
 * Publisher regression test for the "Meta Data Use Checkup (app-owner-action-
 * required) fails closed" fix. Pins the stable fingerprint written to the
 * publish-job row + linked recommendation, and pins the source-shape wire so a
 * Data Use Checkup 400 raised inside a Graph call RETURNS from the publish
 * boundary instead of rethrowing — a rethrow surfaces as a repeated
 * `/api/inngest` crash on every Inngest retry (the exact class this spec
 * closes; the only fix is a human clearing the gate in the Meta App Dashboard).
 *
 * Runs via: npx tsx --test src/lib/inngest/ad-tool.publish-app-owner-action-containment.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The sibling containment test (publish-adset-unavailable) can safely `import` from the
// classifier because it lives in its own module. This spec defines the stable reason
// directly in `ad-tool.ts` (per the spec: "In `src/lib/inngest/ad-tool.ts`, ... add a
// stable `META_APP_OWNER_ACTION_REQUIRED_REASON`"), and importing from `./ad-tool`
// pulls the whole Inngest registered-functions graph — so the fingerprint is pinned via
// source-shape assertion instead of a runtime import.
test("META_APP_OWNER_ACTION_REQUIRED_REASON is the stable fingerprint the publisher writes", async () => {
  const src = await readFile(new URL("./ad-tool.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /export const META_APP_OWNER_ACTION_REQUIRED_REASON\s*=\s*"meta_app_owner_action_required"\s+as\s+const\s*;/,
    "the publisher must export the stable `meta_app_owner_action_required` fingerprint so downstream readers of ad_publish_jobs.error can match it byte-for-byte",
  );
});

test("ad-tool publisher imports the app-owner-action escalation scope helpers", async () => {
  const src = await readFile(new URL("./ad-tool.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /from "@\/lib\/meta\/app-owner-action-escalation"/,
    "the publisher must import from the shared escalation SDK so the deduped CEO card is booked exactly once per workspace per UTC day",
  );
  assert.match(
    src,
    /\binstallDefaultAppOwnerActionEscalationHandler\b/,
    "the publisher must install the default escalation handler so a Data Use Checkup 400 raised inside any Graph call triggers the CEO card",
  );
  // AsyncLocalStorage wrapper — the retired module-global `setCurrentAppOwnerActionWorkspaceScope`
  // raced on concurrent publishes for different workspaces (see the docstring on the escalation
  // SDK). `runWithAppOwnerActionWorkspaceScope` binds the workspace to the ASYNC CHAIN, so two
  // overlapping publishes each see only their own scope.
  assert.match(
    src,
    /\brunWithAppOwnerActionWorkspaceScope\b/,
    "the publisher must scope the handler to the publish's workspace via the ALS-based helper so the deduped card is booked against the RIGHT workspace under concurrent publishes",
  );
});

test("ad-tool publisher wraps the publish work in the ALS workspace scope", async () => {
  const src = await readFile(new URL("./ad-tool.ts", import.meta.url), "utf8");
  // Match the shape: install → `return await runWithAppOwnerActionWorkspaceScope(workspace_id, async () => { … })`.
  // Binding via ALS (not a module-global) is what keeps concurrent publishes from racing scope
  // against each other — the retired mutable pattern booked cards against the wrong workspace
  // when two publishes interleaved awaits.
  const scopeWire =
    /installDefaultAppOwnerActionEscalationHandler\(admin\)[\s\S]*?return\s+await\s+runWithAppOwnerActionWorkspaceScope\(\s*workspace_id\s*,\s*async\s*\(\s*\)\s*=>\s*\{/;
  assert.match(
    src,
    scopeWire,
    "the publish handler must install the escalation handler and wrap the awaited publish work in `runWithAppOwnerActionWorkspaceScope(workspace_id, async () => { … })` so scope cannot leak across concurrent publishes",
  );
});

test("ad-tool publisher catches Meta app_owner_action_required at the Graph publish boundary and returns instead of throwing", async () => {
  const src = await readFile(new URL("./ad-tool.ts", import.meta.url), "utf8");
  // Match the shape: the publish catch classifies via metaClass === "app_owner_action_required",
  // writes the stable reason + publish_active:false to the publish job, and RETURNs the stable
  // reason (never throws). The `throw err` for the residual "other Meta failure" branch below
  // is asserted separately so the containment can't swallow unrelated regressions.
  const contained =
    /catch\s*\([^)]*\)\s*\{[\s\S]*?metaClass\s*===\s*"app_owner_action_required"[\s\S]*?setStatus\(\s*"failed"[\s\S]*?error:\s*META_APP_OWNER_ACTION_REQUIRED_REASON[\s\S]*?publish_active:\s*false[\s\S]*?return\s*\{\s*ok:\s*false,\s*reason:\s*META_APP_OWNER_ACTION_REQUIRED_REASON\s*\}[\s\S]*?throw\s+err\s*;/;
  assert.match(
    src,
    contained,
    "the publish catch must classify app_owner_action_required, write the stable reason + publish_active:false, and RETURN — while still rethrowing every other Meta error so real regressions surface",
  );
});

test("ad-tool publisher mirrors the stable app-owner-action reason onto the linked recommendation", async () => {
  const src = await readFile(new URL("./ad-tool.ts", import.meta.url), "utf8");
  // Inside the classified branch, the recommendation update must also carry
  // META_APP_OWNER_ACTION_REQUIRED_REASON — otherwise Growth's recommendation feed shows a
  // bespoke error message on one side and the stable fingerprint on the other.
  assert.match(
    src,
    /metaClass\s*===\s*"app_owner_action_required"[\s\S]*?iteration_recommendations[\s\S]*?error:\s*META_APP_OWNER_ACTION_REQUIRED_REASON/,
    "when the classifier matches, the recommendation mirror must write META_APP_OWNER_ACTION_REQUIRED_REASON so the publish-job and recommendation rows agree",
  );
});

test("ad-tool publisher rethrows non-app-owner-action Meta failures so real regressions still surface", async () => {
  const src = await readFile(new URL("./ad-tool.ts", import.meta.url), "utf8");
  // The residual "unexpected err" branch inside the same catch must still call setStatus
  // with the raw error text AND rethrow — proving containment is a narrow gate, not a
  // swallow-all. Regex is anchored to the pattern the containment branch ends with (the
  // `return { ok: false, reason: META_APP_OWNER_ACTION_REQUIRED_REASON }`) so it verifies
  // the SAME catch also carries the rethrow path immediately below.
  const residualRethrow =
    /return\s*\{\s*ok:\s*false,\s*reason:\s*META_APP_OWNER_ACTION_REQUIRED_REASON\s*\}[\s\S]*?setStatus\(\s*"failed",\s*\{\s*error:\s*String\(err\?\.message[\s\S]*?throw\s+err\s*;/;
  assert.match(
    src,
    residualRethrow,
    "the publish catch must still rethrow every other Meta error after the app-owner-action branch returns — otherwise a genuine infra regression would be silently masked",
  );
});
