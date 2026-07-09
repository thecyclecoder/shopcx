/**
 * Unit test for the owner-role predicate that gates /api/growth/media-buyer/arm.
 *
 * Fix 1 of media-buyer-grade-rollup-on-growth-director-brief Phase 3: the pre-merge
 * spec-test flagged two findings on src/app/api/growth/media-buyer/arm/route.ts —
 *   [sec:authz_rls]           the arm/disarm gate accepted any workspace_members row
 *   [sec:unsafe_admin_client] service-role writes fired without a role check
 * — both rooted in the same missing predicate. Locking the predicate here proves
 * non-owner members are rejected and owners can proceed to the existing
 * stale-authorization checks, without mutating real prod data.
 *
 * Run:
 *   npm run test:media-buyer-arm-auth
 *   (or: npx tsx --test src/lib/media-buyer/arm-auth.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isWorkspaceOwner } from "./arm-auth";

test("isWorkspaceOwner: owner-role member is admitted", () => {
  assert.equal(isWorkspaceOwner({ role: "owner" }), true);
});

test("isWorkspaceOwner: admin-role member is rejected", () => {
  assert.equal(isWorkspaceOwner({ role: "admin" }), false);
});

test("isWorkspaceOwner: member-role member is rejected", () => {
  assert.equal(isWorkspaceOwner({ role: "member" }), false);
});

test("isWorkspaceOwner: viewer-role member is rejected", () => {
  assert.equal(isWorkspaceOwner({ role: "viewer" }), false);
});

test("isWorkspaceOwner: no matching workspace_members row is rejected (null)", () => {
  assert.equal(isWorkspaceOwner(null), false);
});

test("isWorkspaceOwner: no matching workspace_members row is rejected (undefined)", () => {
  assert.equal(isWorkspaceOwner(undefined), false);
});

test("isWorkspaceOwner: member row with null role is rejected", () => {
  assert.equal(isWorkspaceOwner({ role: null }), false);
});

test("isWorkspaceOwner: member row with missing role is rejected", () => {
  assert.equal(isWorkspaceOwner({}), false);
});

test("isWorkspaceOwner: 'OWNER' (wrong case) is rejected — role is stored lowercase", () => {
  assert.equal(isWorkspaceOwner({ role: "OWNER" }), false);
});
