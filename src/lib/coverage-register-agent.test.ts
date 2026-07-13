/**
 * coverage-register-agent tests. Durable contracts:
 *
 *   A) `inferOwner` is a legacy DOMAIN classifier (growth/cs/retention/cmo/platform, else null) — still
 *      correct, still tested, but NO LONGER decides a loop tile's owner.
 *   B) coverage-register-always-platform (CEO directive, 2026-07): a monitored-loop ENTRY is ALWAYS
 *      `platform`-owned (loop LIVENESS is a platform-reliability concern regardless of the cron's business
 *      domain). So `inferLoopEntry` always sets owner=`platform`, with no low-confidence placeholder / no
 *      "REQUIRES OWNER CONFIRMATION"; `isOwnerConfident` is always true.
 *   C) retire-md-spec-writers-db-is-sole-spec Phase 1 (this lane): `buildRegisterSpecBody` /
 *      `buildExemptSpecBody` return a `StructuredSpecInput` (title/why/what/summary/owner/parent/
 *      phases-with-checks) — NOT markdown — so `runCoverageRegisterJob` authors via the structured
 *      chokepoint `authorSpecRowStructured`. Each phase carries at least one machine-runnable check
 *      (`exec_kind:'grep'` on `src/lib/control-tower/registry.ts` for the loop id) so the deterministic
 *      spec-check runner can verify the registry entry landed after merge — no more prose-only phases
 *      that would fail `assertEveryPhaseHasMachineCheck` and park the job at the CEO inbox.
 *
 * Run: npx tsx --test src/lib/coverage-register-agent.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  inferOwner,
  inferLoopEntry,
  isOwnerConfident,
  buildRegisterSpecBody,
  buildExemptSpecBody,
  COVERAGE_REGISTRY_FILE,
  COVERAGE_FIX_PARENT_KIND,
  COVERAGE_FIX_PARENT_REF,
} from "./coverage-register-agent";
import { assertEveryPhaseHasMachineCheck } from "./author-spec";

test("inferOwner: growth crons — research / creative / acquisition / lander / scout / brand", () => {
  // The named failing state from the accumulated coaching: acquisition-research-cadence-cron and
  // creative-finder-* landed with owner:'platform' + "Confirm the owner-function" boilerplate.
  assert.equal(inferOwner("acquisition-research-cadence-cron"), "growth");
  assert.equal(inferOwner("creative-finder-daily-cron"), "growth");
  assert.equal(inferOwner("creative-finder-video-process"), "growth");
  assert.equal(inferOwner("research-sensor-cron"), "growth");
  assert.equal(inferOwner("storefront-experiments-tick"), "growth");
  assert.equal(inferOwner("meta-fatigue-scan-cron"), "growth");
  assert.equal(inferOwner("lander-blueprint-cron"), "growth");
  assert.equal(inferOwner("scout-daily"), "growth");
  assert.equal(inferOwner("prospect-enrich-cron"), "growth");
  assert.equal(inferOwner("brand-refresh-cron"), "growth");
});

test("inferOwner: cs / retention / cmo shapes", () => {
  assert.equal(inferOwner("ticket-auto-archive"), "cs");
  assert.equal(inferOwner("escalation-triage-cron"), "cs");
  assert.equal(inferOwner("csat-followup"), "cs");
  assert.equal(inferOwner("inbox-drain-cron"), "cs");

  assert.equal(inferOwner("dunning-payday-retry-cron"), "retention");
  assert.equal(inferOwner("subscription-renewal-sweep"), "retention");
  assert.equal(inferOwner("loyalty-tier-refresh"), "retention");
  assert.equal(inferOwner("return-window-close"), "retention");
  assert.equal(inferOwner("refund-audit-cron"), "retention");
  assert.equal(inferOwner("churn-signal-sweep"), "retention");

  assert.equal(inferOwner("scorecard-daily"), "cmo");
  assert.equal(inferOwner("crisis-daily-campaign"), "cmo");
  assert.equal(inferOwner("auto-blog-generate"), "cmo");
});

test("inferOwner: recognized platform infra crons", () => {
  assert.equal(inferOwner("control-tower-monitor"), "platform");
  assert.equal(inferOwner("brain-index-refresh"), "platform");
  assert.equal(inferOwner("security-dep-watch"), "platform");
  assert.equal(inferOwner("platform-director-cron"), "platform");
  assert.equal(inferOwner("deploy-guardian-sweep"), "platform");
  assert.equal(inferOwner("sync-inventory"), "platform");
});

test("inferOwner: returns null on unclassifiable ids — never a silent 'platform' guess", () => {
  // The bake-in guardrail: an id we don't confidently recognize returns null so inferLoopEntry
  // marks the entry low-confidence rather than shipping a fake platform default with the boilerplate
  // "Confirm the owner-function" description. This is the failing state coaching #7 named.
  assert.equal(inferOwner("xyzzy-cadence"), null);
  assert.equal(inferOwner("quux-tick"), null);
  assert.equal(inferOwner(""), null);
});

test("inferLoopEntry: owner is ALWAYS platform (coverage-register-always-platform)", () => {
  // A monitored loop's LIVENESS is a platform-reliability concern, regardless of the cron's business
  // domain — so the tile owner is always platform, even for a growth-shaped id. No placeholder, no warning.
  for (const id of ["acquisition-research-cadence-cron", "ticket-auto-archive", "dunning-payday-retry-cron", "xyzzy-cadence", "quux-tick"]) {
    const entry = inferLoopEntry(id, "0 10 * * *");
    assert.equal(entry.owner, "platform", `${id} → platform`);
    assert.ok(!entry.description.includes("REQUIRES OWNER CONFIRMATION"), `${id}: no low-confidence warning`);
    assert.ok(!entry.description.toLowerCase().includes("placeholder"), `${id}: no placeholder language`);
  }
});

test("isOwnerConfident: always true (owner is always the confident platform)", () => {
  assert.equal(isOwnerConfident("acquisition-research-cadence-cron"), true);
  assert.equal(isOwnerConfident("xyzzy-cadence"), true);
  assert.equal(isOwnerConfident(""), true);
});

test("buildRegisterSpecBody: returns StructuredSpecInput carrying a typed grep machine check on the registry file", () => {
  // The named failing state: the markdown path stamped every phase's Verification prose as
  // exec_kind='needs_human', so `assertEveryPhaseHasMachineCheck` rejected the spec and parked the
  // register job on the CEO inbox. The structured path returns a phase with at least one grep
  // check on src/lib/control-tower/registry.ts asserting the loop id landed, so the gate passes.
  const entry = inferLoopEntry("some-loop-cron", "0 8 16 * *", "2026-07-10T00:00:00.000Z");
  const reg = buildRegisterSpecBody(entry);

  assert.equal(typeof reg.title, "string");
  assert.ok(reg.title.includes("some-loop-cron"), "title mentions the loop id");
  assert.equal(reg.owner, "platform", "register spec owner is platform");
  assert.ok(reg.why && reg.why.trim().length > 0, "register spec has why");
  assert.ok(reg.what && reg.what.trim().length > 0, "register spec has what");
  assert.ok(reg.parent && reg.parent.includes("[[../functions/platform]]"), "register parent anchored to platform mandate");
  assert.ok(reg.phases.length >= 1, "register spec has at least one phase");

  const phase1 = reg.phases[0];
  assert.ok(phase1.body && phase1.body.trim().length > 0, "phase 1 body non-empty");
  assert.ok(phase1.verification && phase1.verification.trim().length > 0, "phase 1 verification non-empty");
  assert.ok(phase1.why && phase1.why.trim().length > 0, "phase 1 why non-empty");
  assert.ok(phase1.what && phase1.what.trim().length > 0, "phase 1 what non-empty");
  assert.ok(phase1.checks && phase1.checks.length >= 1, "phase 1 carries >=1 typed check");

  const grep = phase1.checks!.find((c) => c.exec_kind === "grep");
  assert.ok(grep, "phase 1 has a grep check");
  const params = grep!.params as { path?: string; pattern?: string; expect?: string };
  assert.equal(params.path, COVERAGE_REGISTRY_FILE, "grep targets the registry file");
  assert.equal(params.pattern, "some-loop-cron", "grep pattern is the loop id");
  assert.equal(params.expect, "present", "grep expects the loop id to be present after merge");
});

test("buildExemptSpecBody: returns StructuredSpecInput carrying a typed grep machine check on the registry file", () => {
  // Same shape as the register spec — the loop id must land in registry.ts (INTENTIONALLY_UNMONITORED_CRONS
  // lives in the same file), so the grep check resolves for either outcome.
  const ex = buildExemptSpecBody("some-loop-cron", "platform");

  assert.equal(typeof ex.title, "string");
  assert.ok(ex.title.includes("some-loop-cron"), "title mentions the loop id");
  assert.equal(ex.owner, "platform", "exempt spec owner is platform");
  assert.ok(ex.why && ex.why.trim().length > 0, "exempt spec has why");
  assert.ok(ex.what && ex.what.trim().length > 0, "exempt spec has what");
  assert.ok(ex.parent && ex.parent.includes("[[../functions/platform]]"), "exempt parent anchored to platform mandate");
  assert.ok(ex.phases.length >= 1, "exempt spec has at least one phase");

  const phase1 = ex.phases[0];
  assert.ok(phase1.checks && phase1.checks.length >= 1, "phase 1 carries >=1 typed check");
  const grep = phase1.checks!.find((c) => c.exec_kind === "grep");
  assert.ok(grep, "phase 1 has a grep check");
  const params = grep!.params as { path?: string; pattern?: string; expect?: string };
  assert.equal(params.path, COVERAGE_REGISTRY_FILE);
  assert.equal(params.pattern, "some-loop-cron");
  assert.equal(params.expect, "present");
});

test("both structured spec inputs pass assertEveryPhaseHasMachineCheck (chokepoint accepts them)", () => {
  // Regression guard for MissingMachineCheckError: the deterministic gate rejected the markdown path
  // because prose Verification bullets stamped exec_kind='needs_human'. The structured path's typed
  // grep checks satisfy the ≥1-machine-runnable-check-per-phase invariant so the author lands.
  const entry = inferLoopEntry("some-loop-cron", "0 8 * * *", "2026-07-10T00:00:00.000Z");
  const reg = buildRegisterSpecBody(entry);
  const ex = buildExemptSpecBody("some-loop-cron", "platform");

  assert.doesNotThrow(() =>
    assertEveryPhaseHasMachineCheck(
      "register-loop-some-loop-cron",
      reg.phases.map((p) => ({ title: p.title, checks: p.checks ?? [] })),
    ),
  );
  assert.doesNotThrow(() =>
    assertEveryPhaseHasMachineCheck(
      "exempt-loop-some-loop-cron",
      ex.phases.map((p) => ({ title: p.title, checks: p.checks ?? [] })),
    ),
  );
});

test("COVERAGE_FIX_PARENT_REF is the platform infra-devops-reliability mandate", () => {
  // The mandate anchor keeps the chokepoint's `assertValidParent` from rejecting the parent as
  // bare-function free-text. Mirrors mario's fix-spec anchor (`platform#infra-devops-reliability`).
  assert.equal(COVERAGE_FIX_PARENT_KIND, "mandate");
  assert.equal(COVERAGE_FIX_PARENT_REF, "platform#infra-devops-reliability");
});
