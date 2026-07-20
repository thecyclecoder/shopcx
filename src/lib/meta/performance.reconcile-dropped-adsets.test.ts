// Pin the pure `reconcileDroppedAdsetIds` helper: Meta excludes archived adsets
// from its default `/adsets` list, so an adset that USED to belong to a synced
// campaign but Meta didn't return this run must be flipped to ARCHIVED in the
// mirror — scoped to the synced campaigns, never account-wide. The Superfood
// Tabs incident (two adsets stuck ACTIVE forever) is the exact case here.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { reconcileDroppedAdsetIds } from "./performance";

test("mirrored adset in a synced campaign that Meta didn't return → dropped", () => {
  const dropped = reconcileDroppedAdsetIds(
    ["c1"],
    ["a-live"],
    [
      { meta_adset_id: "a-live", meta_campaign_id: "c1", status: "ACTIVE" },
      { meta_adset_id: "a-gone", meta_campaign_id: "c1", status: "ACTIVE" },
    ],
  );
  assert.deepEqual(dropped, ["a-gone"]);
});

test("adset in a NON-synced campaign is left alone (scope guard)", () => {
  const dropped = reconcileDroppedAdsetIds(
    ["c1"],
    ["a-live"],
    [
      { meta_adset_id: "a-live", meta_campaign_id: "c1", status: "ACTIVE" },
      { meta_adset_id: "a-other", meta_campaign_id: "c-other", status: "ACTIVE" },
    ],
  );
  assert.deepEqual(dropped, []);
});

test("already-ARCHIVED adset is not re-flipped (idempotent)", () => {
  const dropped = reconcileDroppedAdsetIds(
    ["c1"],
    [],
    [
      { meta_adset_id: "a-already-archived", meta_campaign_id: "c1", status: "ARCHIVED" },
    ],
  );
  assert.deepEqual(dropped, []);
});

test("empty synced-campaigns list → no reconcile (nothing to scope over)", () => {
  const dropped = reconcileDroppedAdsetIds(
    [],
    [],
    [{ meta_adset_id: "a-live", meta_campaign_id: "c1", status: "ACTIVE" }],
  );
  assert.deepEqual(dropped, []);
});

test("returned set membership uses string equality (no coercion drift)", () => {
  const dropped = reconcileDroppedAdsetIds(
    ["c1"],
    ["120000000000000001"],
    [
      { meta_adset_id: "120000000000000001", meta_campaign_id: "c1", status: "ACTIVE" },
      { meta_adset_id: "120000000000000002", meta_campaign_id: "c1", status: "ACTIVE" },
    ],
  );
  assert.deepEqual(dropped, ["120000000000000002"]);
});

test("null meta_campaign_id on a mirror row is skipped (unscoped orphan)", () => {
  const dropped = reconcileDroppedAdsetIds(
    ["c1"],
    [],
    [
      { meta_adset_id: "a-orphan", meta_campaign_id: null, status: "ACTIVE" },
      { meta_adset_id: "a-scoped", meta_campaign_id: "c1", status: "ACTIVE" },
    ],
  );
  assert.deepEqual(dropped, ["a-scoped"]);
});
