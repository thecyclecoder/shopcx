/**
 * Pins the `metaSyncSpend` error-branch classifier (docs/brain/specs/
 * meta-sync-spend-data-use-checkup-human-blocked.md Phase 1).
 *
 * Meta's Data Use Checkup 400 is a HUMAN-blocked state that persists until
 * the app owner clears it in the App Dashboard — the escalation handler in
 * meta-sync.ts already books ONE deduped CEO card per workspace per UTC day,
 * so the Inngest function must CONTAIN the tagged error as a stable
 * human-blocked result rather than letting it become an unhandled crash that
 * floods the Control Tower error feed with duplicates. A plain fatal Meta
 * 400 (missing the tag) must still propagate.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/meta-sync.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED,
  classifyMetaSyncSpendError,
} from "./meta-sync";

const SCOPE = {
  workspaceId: "ws-1",
  adAccountId: "uuid-cre",
  metaAccountId: "act-cre",
};

test("classifyMetaSyncSpendError — Data Use Checkup tag is contained as the stable human-blocked fingerprint", () => {
  // Canonical case: graph-retry.ts tags the 400 with metaClass='app_owner_action_required'.
  const err = Object.assign(
    new Error("meta_400: API access disrupted. Go to the App Dashboard and complete Data Use Checkup."),
    { metaClass: "app_owner_action_required", httpStatus: 400 },
  );
  const blocked = classifyMetaSyncSpendError(err, SCOPE);
  assert.deepEqual(blocked, {
    status: META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED,
    workspaceId: SCOPE.workspaceId,
    adAccountId: SCOPE.adAccountId,
    metaAccountId: SCOPE.metaAccountId,
  });
});

test("classifyMetaSyncSpendError — plain fatal Meta 400 (no tag) still propagates (returns null → caller rethrows)", () => {
  // Untagged Meta 400 (validation, permissions, etc.) is a real failure the
  // Inngest failure feed should still surface — only the app-owner-action tag
  // is contained.
  const err = new Error("meta_400: Invalid parameter");
  assert.equal(classifyMetaSyncSpendError(err, SCOPE), null);
});

test("classifyMetaSyncSpendError — unrelated metaClass does not match", () => {
  const err = Object.assign(new Error("meta_400: Feature no longer supported"), {
    metaClass: "permanent_api_removed",
  });
  assert.equal(classifyMetaSyncSpendError(err, SCOPE), null);
});

test("classifyMetaSyncSpendError — null / non-Error input is safe (no throw, returns null)", () => {
  assert.equal(classifyMetaSyncSpendError(null, SCOPE), null);
  assert.equal(classifyMetaSyncSpendError("some string", SCOPE), null);
});

test("META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED — stable fingerprint literal (grepable pin)", () => {
  // Pin the exact literal so a rename that would break downstream Control
  // Tower filters / dashboards trips this test before shipping.
  assert.equal(
    META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED,
    "meta_sync_spend_app_owner_action_required",
  );
});
