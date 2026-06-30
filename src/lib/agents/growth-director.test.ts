/**
 * Unit tests for the Growth Director Phase-1 leash gate (growth-director-agent spec).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:growth-director
 *   (= tsx --test src/lib/agents/growth-director.test.ts)
 *
 * Mirrors the platform-director Phase-1 surface: exercises `directorLeashCandidates` against fixture
 * pending-action bundles (in-leash single, in-leash multi, out-of-leash mixed, empty, unknown type) and
 * `growthIsAutoApprover` against fixture autonomy maps.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { type AutonomyMap } from "./approval-router";
import {
  directorLeashCandidates,
  growthIsAutoApprover,
  LEASH_CATEGORIES,
  type DirectorTargetJob,
} from "./growth-director";

const job = (actions: DirectorTargetJob["pending_actions"]): DirectorTargetJob => ({
  id: "job-1",
  workspace_id: "ws-1",
  kind: "approval_request",
  spec_slug: null,
  status: "needs_approval",
  pending_actions: actions,
});

test("empty pending_actions ⇒ verdict 'none', no actions", () => {
  assert.deepEqual(directorLeashCandidates(job([])), { actions: [], verdict: "none" });
  assert.deepEqual(directorLeashCandidates(job(null)), { actions: [], verdict: "none" });
});

test("single in-leash action ⇒ verdict 'single' + the action's category", () => {
  for (const category of LEASH_CATEGORIES) {
    const out = directorLeashCandidates(job([{ id: "a1", type: category }]));
    assert.equal(out.verdict, "single", `category=${category}`);
    assert.deepEqual(out.actions, [{ actionId: "a1", category }]);
  }
});

test("bundle where EVERY action is in-leash ⇒ verdict 'multi' + every category in order", () => {
  const out = directorLeashCandidates(
    job([
      { id: "a1", type: "iteration_policy_activation" },
      { id: "a2", type: "storefront_optimizer_policy_activation" },
      { id: "a3", type: "promote_ready_to_test_creative" },
    ]),
  );
  assert.equal(out.verdict, "multi");
  assert.deepEqual(out.actions, [
    { actionId: "a1", category: "iteration_policy_activation" },
    { actionId: "a2", category: "storefront_optimizer_policy_activation" },
    { actionId: "a3", category: "promote_ready_to_test_creative" },
  ]);
});

test("ONE out-of-leash action ⇒ the WHOLE bundle escalates (verdict 'none', actions empty)", () => {
  const out = directorLeashCandidates(
    job([
      { id: "a1", type: "iteration_policy_activation" },
      { id: "a2", type: "drop_table" }, // destructive — never in-leash
      { id: "a3", type: "pause_underperforming_creative" },
    ]),
  );
  assert.deepEqual(out, { actions: [], verdict: "none" });
});

test("a single unknown action type ⇒ verdict 'none' (fail-safe — never auto-approve unrecognized types)", () => {
  assert.deepEqual(
    directorLeashCandidates(job([{ id: "a1", type: "some_new_growth_action" }])),
    { actions: [], verdict: "none" },
  );
});

test("an action missing its id is filtered out (no id ⇒ can't be approved)", () => {
  const out = directorLeashCandidates(
    job([
      { type: "iteration_policy_activation" }, // no id
      { id: "a2", type: "pause_underperforming_creative" },
    ]),
  );
  assert.equal(out.verdict, "single");
  assert.deepEqual(out.actions, [{ actionId: "a2", category: "pause_underperforming_creative" }]);
});

test("only pending actions count — already-approved/declined actions in the bundle are ignored", () => {
  const out = directorLeashCandidates(
    job([
      { id: "a1", type: "iteration_policy_activation", status: "approved" },
      { id: "a2", type: "pause_underperforming_creative" }, // pending by default
    ]),
  );
  assert.equal(out.verdict, "single");
  assert.deepEqual(out.actions, [{ actionId: "a2", category: "pause_underperforming_creative" }]);
});

test("growthIsAutoApprover requires BOTH live + autonomous on the growth row", () => {
  const on: AutonomyMap = { growth: { live: true, autonomous: true } };
  const liveOnly: AutonomyMap = { growth: { live: true, autonomous: false } };
  const off: AutonomyMap = { growth: { live: false, autonomous: false } };
  const otherOn: AutonomyMap = { platform: { live: true, autonomous: true } };
  assert.equal(growthIsAutoApprover(on), true);
  assert.equal(growthIsAutoApprover(liveOnly), false);
  assert.equal(growthIsAutoApprover(off), false);
  assert.equal(growthIsAutoApprover(otherOn), false); // a peer being on never makes growth the approver
  assert.equal(growthIsAutoApprover({}), false); // missing row ⇒ off (fail-safe)
});
