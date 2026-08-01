/**
 * Pins the isMetaHumanActionBlock classifier (docs/brain/specs/
 * error-feed-meta-today-sync-data-use-checkup-human-blocked.md Phase 1).
 *
 * Meta's 'Data Use Checkup' enforcement is a HUMAN-blocked state that
 * persists until the app owner completes the checkup in Meta's App
 * Dashboard, so the classifier must recognise the production signature
 * (and casing variants) while leaving unrelated Meta 400s alone.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/today-sync.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isMetaHumanActionBlock } from "./today-sync";

test("isMetaHumanActionBlock matches the exact production signature", () => {
  const err = new Error(
    "meta_400: API access disrupted. Go to the App Dashboard and complete Data Use Checkup.",
  );
  assert.equal(isMetaHumanActionBlock(err), true);
});

test("isMetaHumanActionBlock is casing-insensitive", () => {
  const err = new Error(
    "META_400: api ACCESS Disrupted — go to the app dashboard and complete DATA USE checkup.",
  );
  assert.equal(isMetaHumanActionBlock(err), true);
});

test("isMetaHumanActionBlock does not fire on unrelated Meta 400s", () => {
  const err = new Error("meta_400: Invalid parameter");
  assert.equal(isMetaHumanActionBlock(err), false);
});
