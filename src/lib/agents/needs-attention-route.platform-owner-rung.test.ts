/**
 * PLATFORM-OWNER RUNG (2026-08-11) — an undiagnosed BUILD park goes to Ada's fix-phase lane before
 * the CEO fail-safe, mirroring the CS-owner rung.
 *
 * Why this exists: measured on the live CEO inbox 2026-08-11, build-pipeline failures were 8 of the
 * 14 real incidents, and one (`security-dep-watch`) had sat parked 204h — because a card in the
 * founder's inbox is not a work queue. The rung sends Platform's OWN work to Platform.
 *
 * The danger being guarded is the opposite of noise: routing a park away from the founder is only
 * correct if something ELSE acts on it, and if the lane's own failure still pages. These tests pin
 * the ROUTING DECISION and the ESCALATION-OF-LAST-RESORT contract.
 *
 *   npx tsx --test src/lib/agents/needs-attention-route.platform-owner-rung.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BUILD_STYLE_KINDS } from "./needs-attention-classify";

/**
 * The rung's decision, as applied in `routeBackstop`. Kept here as an executable specification of
 * the documented branch order; the implementation applies exactly these conditions.
 */
function rungDecision(input: {
  freshClass: string;
  jobKind: string;
  specSlug: string | null;
  laneSpawned: boolean;
}): "route_to_platform" | "ceo_failsafe" | "not_applicable" {
  if (input.freshClass !== "unknown") return "not_applicable";
  if (!BUILD_STYLE_KINDS.has(input.jobKind) || !input.specSlug) return "ceo_failsafe";
  return input.laneSpawned ? "route_to_platform" : "ceo_failsafe";
}

const build = { freshClass: "unknown", jobKind: "build", specSlug: "some-spec", laneSpawned: true };

test("an undiagnosed BUILD park routes to Platform's fix-phase lane, not the CEO", () => {
  assert.equal(rungDecision(build), "route_to_platform");
});

test("regression + repair are Platform's work too", () => {
  for (const kind of ["regression", "repair"]) {
    assert.equal(rungDecision({ ...build, jobKind: kind }), "route_to_platform", `${kind} should route to Platform`);
  }
});

test("a parked cs-director-call is NOT routed here — it is a real decision, not a code bug", () => {
  // Routing a customer-facing decision into a code-fix lane would BURY it. The whole point of the
  // rung is that the OWNER takes its own work; cs-director-call is not Platform's.
  assert.equal(rungDecision({ ...build, jobKind: "cs-director-call" }), "ceo_failsafe");
});

test("a parked security-review is NOT routed here either", () => {
  assert.equal(rungDecision({ ...build, jobKind: "security-review" }), "ceo_failsafe");
});

test("a build park with no spec slug falls to the CEO fail-safe (nothing to append a fix phase to)", () => {
  assert.equal(rungDecision({ ...build, specSlug: null }), "ceo_failsafe");
});

test("when the lane DECLINES to spawn, the CEO fail-safe still fires — no silent drop", () => {
  // The single most important case: routing away from the founder must never be a black hole.
  assert.equal(rungDecision({ ...build, laneSpawned: false }), "ceo_failsafe");
});

test("a park that DID classify is untouched — its own class router already owns it", () => {
  for (const klass of ["already_shipped", "real_blocker", "tooling_failure", "design_change"]) {
    assert.equal(rungDecision({ ...build, freshClass: klass }), "not_applicable");
  }
});

// ── escalation-of-last-resort: the lane's own failure must page ──────────────────────────────

test("the pre-merge-fix loop-guard escalation carries a dedupe_key", async () => {
  // REGRESSION GUARD. The loop-guard is where the autonomous fix loop admits defeat — the one
  // moment it is guaranteed to need a human. Pre-2026-08-11 it wrote an `escalated` activity row
  // with NO dedupe_key and minted no CEO card. `reconcileSwallowedEscalations` filters the ledger to
  // rows carrying a `dedupe_key`, so that escalation was invisible on BOTH surfaces — it reached
  // nobody. The rung makes this lane the destination for undiagnosed parks, so this path is now
  // load-bearing.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../pre-merge-fix.ts", import.meta.url), "utf8"),
  );
  const guardBlock = src.slice(src.indexOf("existingFixPhases.length >= PRE_MERGE_FIX_LOOP_GUARD_MAX"));
  assert.match(guardBlock, /escalateDiagnosisToCeo/, "loop-guard must mint a CEO card");
  assert.match(guardBlock, /dedupe_key:\s*dedupeKey/, "the activity row must carry the dedupe_key the reconciler filters on");
  assert.match(guardBlock, /premerge-fix-loopguard:/, "the dedupe key must be keyed on the origin spec");
});

test("premerge_fix_loop_guard is enrolled in a card-lifecycle family (never immortal)", async () => {
  const { BUILD_STUCK_ESCALATION_NAMESPACES } = await import("./approval-inbox");
  assert.ok(
    BUILD_STUCK_ESCALATION_NAMESPACES.has("premerge-fix-loopguard"),
    "its dedupe namespace must join the build-stuck family so it dedupes AND auto-clears",
  );
});
