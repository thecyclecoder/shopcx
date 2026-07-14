/**
 * Unit tests for the fail-closed PR-selection helper the GitHub-PR-merged reconciler uses
 * (stamp-phases-on-github-pr-merged Phase 2). Pins the four verification bullets from the spec:
 *
 *   1. an OPEN PR is NEVER stamped;
 *   2. a CLOSED-without-merge PR is NEVER stamped;
 *   3. a branch with BOTH a MERGED and a CLOSED-unmerged PR resolves to the MERGED PR — regardless
 *      of API iteration order (the #961-merged / #949-closed shape from fix-spec-brain-refs);
 *   4. on a simulated GitHub read failure (null/undefined/non-array) the picker returns null and
 *      does NOT throw, so the outer reconciler skips the spec and a later pass retries.
 *
 * Pure helper — no I/O, no DB. Run:
 *   npm run test:spec-drift
 *   (= tsx --test src/lib/spec-drift.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReverseDriftInboxRow,
  isGoalPendingPromotion,
  isMergeShaAncestorOfMain,
  pickMergedPrFromList,
  pickPhasesBuiltInMerge,
  reverseDriftDedupeKey,
  type BranchPrCandidate,
  type PhaseBuiltCandidate,
} from "./spec-drift";
import type { GoalRow } from "./goals-table";

const OPEN: BranchPrCandidate = { number: 100, merged_at: null, merge_commit_sha: null };
const CLOSED_UNMERGED: BranchPrCandidate = { number: 949, merged_at: null, merge_commit_sha: null };
const MERGED: BranchPrCandidate = {
  number: 961,
  merged_at: "2026-07-02T00:00:00Z",
  merge_commit_sha: "deadbeef",
};

test("pickMergedPrFromList: an empty list yields null (no PRs → no stamp)", () => {
  assert.equal(pickMergedPrFromList([]), null);
});

test("pickMergedPrFromList: an OPEN PR is NEVER stamped (bullet 1)", () => {
  assert.equal(pickMergedPrFromList([OPEN]), null);
});

test("pickMergedPrFromList: a CLOSED-unmerged PR is NEVER stamped (bullet 2 — the #949-closed shape)", () => {
  assert.equal(pickMergedPrFromList([CLOSED_UNMERGED]), null);
});

test("pickMergedPrFromList: a MERGED PR stamps with its number + merge_commit_sha (positive path)", () => {
  assert.deepEqual(pickMergedPrFromList([MERGED]), { number: 961, merge_sha: "deadbeef" });
});

test("pickMergedPrFromList: MERGED wins over CLOSED-unmerged when CLOSED comes FIRST (bullet 3 — iteration order shouldn't matter)", () => {
  // The #961-merged / #949-closed shape from fix-spec-brain-refs: API might return CLOSED first.
  assert.deepEqual(pickMergedPrFromList([CLOSED_UNMERGED, MERGED]), {
    number: 961,
    merge_sha: "deadbeef",
  });
});

test("pickMergedPrFromList: MERGED wins over CLOSED-unmerged when MERGED comes FIRST (bullet 3 — the symmetric order)", () => {
  assert.deepEqual(pickMergedPrFromList([MERGED, CLOSED_UNMERGED]), {
    number: 961,
    merge_sha: "deadbeef",
  });
});

test("pickMergedPrFromList: MERGED wins over an OPEN PR too (bullet 3 — should generalize past the CLOSED case)", () => {
  assert.deepEqual(pickMergedPrFromList([OPEN, MERGED]), { number: 961, merge_sha: "deadbeef" });
});

test("pickMergedPrFromList: a MERGED PR without a merge_commit_sha still stamps (with merge_sha=null) — a stamp with a real PR # is provenance enough for the audit trail", () => {
  const mergedNoSha: BranchPrCandidate = {
    number: 962,
    merged_at: "2026-07-02T00:00:00Z",
    merge_commit_sha: null,
  };
  assert.deepEqual(pickMergedPrFromList([mergedNoSha]), { number: 962, merge_sha: null });
});

test("pickMergedPrFromList: null input yields null and does NOT throw (bullet 4 — simulated GitHub read failure)", () => {
  assert.doesNotThrow(() => pickMergedPrFromList(null));
  assert.equal(pickMergedPrFromList(null), null);
});

test("pickMergedPrFromList: undefined input yields null and does NOT throw (bullet 4 — the missing-token / no-payload shape)", () => {
  assert.doesNotThrow(() => pickMergedPrFromList(undefined));
  assert.equal(pickMergedPrFromList(undefined), null);
});

test("pickMergedPrFromList: a non-array payload (e.g. GitHub returned an error object) yields null (bullet 4 — the outer guard `Array.isArray(res.json)` fails, but the picker is defensive too)", () => {
  const garbage = { message: "Bad credentials" } as unknown as BranchPrCandidate[];
  assert.doesNotThrow(() => pickMergedPrFromList(garbage));
  assert.equal(pickMergedPrFromList(garbage), null);
});

// ── isGoalPendingPromotion — reese-goal-aware-drift Phase 1 ────────────────────────────────────
//
// The named failing state: a shipped phase of a goal member whose goal.main_merge_sha is null was
// being classified as reverse-drift by the on-main path check (three currently-open Sol rows).
// These tests pin the guard: the goal-pending case returns `pending: true`; every non-pending shape
// (standalone spec / goal member post-merge / unknown milestone) returns `pending: false` so a
// genuine post-merge revert still opens a drift row.

const NOW = "2026-07-08T00:00:00Z";
function goal(input: { slug: string; milestones: Array<{ id: string; position?: number; title?: string }>; main_merge_sha: string | null }): GoalRow {
  return {
    id: `g-${input.slug}`,
    workspace_id: "ws",
    slug: input.slug,
    title: input.slug,
    body: "",
    outcome: null,
    success_metric: null,
    owner: "platform",
    proposer_function: null,
    parent_goal_id: null,
    is_parent: false,
    status: "greenlit",
    why: null,
    main_merge_sha: input.main_merge_sha,
    promotion_held_reason: null,
    created_at: NOW,
    updated_at: NOW,
    milestones: input.milestones.map((m, i) => ({
      id: m.id,
      goal_id: `g-${input.slug}`,
      position: m.position ?? i + 1,
      title: m.title ?? `M${i + 1}`,
      body: null,
      why: null,
      what: null,
      created_at: NOW,
      updated_at: NOW,
    })),
  };
}

test("isGoalPendingPromotion: goal member whose goal main_merge_sha is null → pending:true (the Sol false-positive shape)", () => {
  const goals = [goal({ slug: "sol", milestones: [{ id: "m-sol-1" }], main_merge_sha: null })];
  const v = isGoalPendingPromotion("m-sol-1", goals);
  assert.equal(v.pending, true);
  assert.equal(v.goalSlug, "sol");
});

test("isGoalPendingPromotion: goal member AFTER its goal promoted (main_merge_sha set) → pending:false (drift row still opens for real revert)", () => {
  const goals = [goal({ slug: "sol", milestones: [{ id: "m-sol-1" }], main_merge_sha: "abc123" })];
  const v = isGoalPendingPromotion("m-sol-1", goals);
  assert.equal(v.pending, false);
});

test("isGoalPendingPromotion: standalone spec (milestone_id null) → pending:false (never suppressed)", () => {
  const goals = [goal({ slug: "sol", milestones: [{ id: "m-sol-1" }], main_merge_sha: null })];
  assert.equal(isGoalPendingPromotion(null, goals).pending, false);
  assert.equal(isGoalPendingPromotion(undefined, goals).pending, false);
});

test("isGoalPendingPromotion: milestone_id present but not in any known goal → pending:false (fail-safe; never suppress real drift)", () => {
  const goals = [goal({ slug: "sol", milestones: [{ id: "m-sol-1" }], main_merge_sha: null })];
  assert.equal(isGoalPendingPromotion("m-unknown", goals).pending, false);
});

test("isGoalPendingPromotion: empty goals list → pending:false (listGoals read failure fell back to [])", () => {
  assert.equal(isGoalPendingPromotion("m-sol-1", []).pending, false);
});

test("isGoalPendingPromotion: correct goal picked when multiple goals + multiple milestones present", () => {
  const goals = [
    goal({ slug: "sol", milestones: [{ id: "m-sol-1" }, { id: "m-sol-2" }], main_merge_sha: null }),
    goal({ slug: "luna", milestones: [{ id: "m-luna-1" }], main_merge_sha: "shipped" }),
  ];
  assert.equal(isGoalPendingPromotion("m-sol-2", goals).goalSlug, "sol");
  assert.equal(isGoalPendingPromotion("m-sol-2", goals).pending, true);
  assert.equal(isGoalPendingPromotion("m-luna-1", goals).pending, false);
});

// ── reverse-drift → CEO inbox — reese-goal-aware-drift Phase 2 ─────────────────────────────────
//
// Phase 2 verification: a confirmed reverse-drift produces an item in the CEO approvals/inbox feed
// naming the spec + phase + missing-code detail; a re-surfaced same row does not create a duplicate
// inbox item. The de-dupe surface is the notification's `metadata.dedupe_key` — a stable
// per-(workspace, spec, phase) key means the emitter finds the OPEN card and refreshes it instead
// of inserting a duplicate. These tests pin the pure helpers that make that de-dupe possible.

test("reverseDriftDedupeKey: stable across re-surfacings of the same (workspace, spec, phase)", () => {
  const k1 = reverseDriftDedupeKey({ workspaceId: "ws-a", specSlug: "sol", phaseIndex: 0 });
  const k2 = reverseDriftDedupeKey({ workspaceId: "ws-a", specSlug: "sol", phaseIndex: 0 });
  assert.equal(k1, k2);
});

test("reverseDriftDedupeKey: distinguishes different phases of the same spec", () => {
  const kP1 = reverseDriftDedupeKey({ workspaceId: "ws-a", specSlug: "sol", phaseIndex: 0 });
  const kP2 = reverseDriftDedupeKey({ workspaceId: "ws-a", specSlug: "sol", phaseIndex: 1 });
  assert.notEqual(kP1, kP2);
});

test("reverseDriftDedupeKey: distinguishes different specs in the same workspace", () => {
  const kSol = reverseDriftDedupeKey({ workspaceId: "ws-a", specSlug: "sol", phaseIndex: 0 });
  const kLuna = reverseDriftDedupeKey({ workspaceId: "ws-a", specSlug: "luna", phaseIndex: 0 });
  assert.notEqual(kSol, kLuna);
});

test("reverseDriftDedupeKey: distinguishes the same (spec, phase) across workspaces (never cross-workspace collide)", () => {
  const kA = reverseDriftDedupeKey({ workspaceId: "ws-a", specSlug: "sol", phaseIndex: 0 });
  const kB = reverseDriftDedupeKey({ workspaceId: "ws-b", specSlug: "sol", phaseIndex: 0 });
  assert.notEqual(kA, kB);
});

test("buildReverseDriftInboxRow: title names spec + phase + explains code-missing-from-main", () => {
  const row = buildReverseDriftInboxRow({
    workspaceId: "ws-a",
    specSlug: "sol",
    phaseIndex: 0,
    phaseTitle: "Make the drift check goal-aware",
    detail: "src/lib/spec-drift.ts missing from main",
    driftRowId: "drift-1",
  });
  assert.ok(row.title.includes("sol"), "title includes spec slug");
  assert.ok(row.title.includes("P1"), "title includes 1-based phase number");
  assert.ok(row.title.includes("Make the drift check goal-aware"), "title includes phase title");
  assert.ok(row.title.includes("code missing"), "title explains the failure mode");
});

test("buildReverseDriftInboxRow: body surfaces the missing-code detail + the CEO's actionable choices", () => {
  const row = buildReverseDriftInboxRow({
    workspaceId: "ws-a",
    specSlug: "sol",
    phaseIndex: 2,
    phaseTitle: "Route to CEO inbox",
    detail: "paths not on main (src/lib/spec-drift.ts)",
    driftRowId: "drift-2",
  });
  assert.ok(row.body.includes("sol"), "body names the spec");
  assert.ok(row.body.includes("P3"), "body names the 1-based phase number");
  assert.ok(row.body.includes("Route to CEO inbox"), "body names the phase title");
  assert.ok(row.body.includes("paths not on main"), "body carries the missing-code detail");
  assert.match(row.body, /rebuild|revert|downgrade/i, "body names the CEO's next-action choices");
});

test("buildReverseDriftInboxRow: metadata carries the escalate_founder fields the approvals feed reads", () => {
  const row = buildReverseDriftInboxRow({
    workspaceId: "ws-a",
    specSlug: "sol",
    phaseIndex: 0,
    phaseTitle: "P1",
    detail: "d",
    driftRowId: "drift-1",
  });
  assert.equal(row.metadata.routed_to_function, "ceo", "routes to the CEO inbox");
  assert.equal(row.metadata.escalation_kind, "spec_drift_reverse", "typed escalation kind");
  assert.equal(row.metadata.spec_slug, "sol");
  assert.equal(row.metadata.phase_index, 0);
  assert.equal(row.metadata.phase_title, "P1");
  assert.equal(row.metadata.drift_row_id, "drift-1");
  assert.equal(row.metadata.dedupe_key, reverseDriftDedupeKey({ workspaceId: "ws-a", specSlug: "sol", phaseIndex: 0 }), "dedupe_key matches the pure helper");
});

test("buildReverseDriftInboxRow: same (workspace, spec, phase) always produces the same dedupe_key regardless of detail (the re-surface de-dupe contract)", () => {
  const base = { workspaceId: "ws-a", specSlug: "sol", phaseIndex: 0, phaseTitle: "P1", driftRowId: "drift-1" };
  const first = buildReverseDriftInboxRow({ ...base, detail: "first pass detail" });
  const later = buildReverseDriftInboxRow({ ...base, detail: "later pass, different detail" });
  assert.equal(first.metadata.dedupe_key, later.metadata.dedupe_key,
    "the dedupe_key is stable across passes so a persistent drift row bumps the existing card, never mints a duplicate");
});

test("buildReverseDriftInboxRow: title/body truncated to safe lengths so a pathological detail can't overflow the notification column", () => {
  const massive = "x".repeat(10_000);
  const row = buildReverseDriftInboxRow({
    workspaceId: "ws-a",
    specSlug: "sol",
    phaseIndex: 0,
    phaseTitle: "P1",
    detail: massive,
    driftRowId: "drift-1",
  });
  assert.ok(row.title.length <= 200, `title must be ≤ 200 chars (got ${row.title.length})`);
  assert.ok(row.body.length <= 4000, `body must be ≤ 4000 chars (got ${row.body.length})`);
  assert.ok(row.metadata.escalation_reason.length <= 2000, `escalation_reason must be ≤ 2000 chars (got ${row.metadata.escalation_reason.length})`);
});

// ── pickPhasesBuiltInMerge — reconciler-spec-drift-stamps-only-built-phases-in-merged-pr P1 ────
//
// The live incident (generalize-director-coach-backend): PR #1712 merged with ONLY Phase 1
// (coach/route.ts +26) in the diff, but the old drift-healer stamped ALL three phases shipped
// from the mere "PR merged" signal — so Phases 2/3 dead-ended as "already shipped" (their auto-
// queued builds never re-ran), the spec-test correctly failed them, and the spec locked into a
// permanent shipped-but-red fold-deadlock. These tests pin the pure filter that closes it:
//
//   - build_sha set → stamp (the worker recorded a real branch build);
//   - build_sha null + a declared file in the merge diff → stamp (manually smuggled into squash);
//   - build_sha null + NO file in the merge diff → SKIP (leave for its own build-session re-queue);
//   - mergedFiles=null (GitHub read failure) → collapse to build_sha-only, don't over-stamp.

const P1_BUILT: PhaseBuiltCandidate = {
  position: 1,
  build_sha: "abc123",
  body: "Wire coach in `src/app/api/director/coach/route.ts` — the entry point.",
};
const P2_UNBUILT: PhaseBuiltCandidate = {
  position: 2,
  build_sha: null,
  body: "Per-director framing lives in `src/lib/coach/director-framing.ts` for the second phase.",
};
const P3_UNBUILT: PhaseBuiltCandidate = {
  position: 3,
  build_sha: null,
  body: "Profile page reads `hasCoachThread` from `src/app/dashboard/profile/page.tsx`.",
};

test("pickPhasesBuiltInMerge: the generalize-director-coach-backend #1712 shape — merge diff touches ONLY P1's files → stamps ONLY P1, leaves P2+P3 for re-queue (spec's local-replay bullet)", () => {
  const files = new Set(["src/app/api/director/coach/route.ts"]);
  const v = pickPhasesBuiltInMerge([P1_BUILT, P2_UNBUILT, P3_UNBUILT], files);
  assert.deepEqual(
    v.stamped.map((s) => s.position),
    [1],
    "only P1 (with build_sha) is stamped",
  );
  assert.deepEqual(v.skipped, [2, 3], "P2+P3 are left for their own build sessions");
});

test("pickPhasesBuiltInMerge: build_sha set → stamped with reason 'build_sha' (the primary signal)", () => {
  const v = pickPhasesBuiltInMerge([P1_BUILT], new Set());
  assert.equal(v.stamped.length, 1);
  assert.equal(v.stamped[0].reason, "build_sha");
  assert.equal(v.skipped.length, 0);
});

test("pickPhasesBuiltInMerge: build_sha null but a declared file appears in the merge diff → stamped with reason 'file-diff' (the manual-squash fallback)", () => {
  const v = pickPhasesBuiltInMerge([P2_UNBUILT], new Set(["src/lib/coach/director-framing.ts"]));
  assert.equal(v.stamped.length, 1);
  assert.equal(v.stamped[0].reason, "file-diff");
  assert.equal(v.skipped.length, 0);
});

test("pickPhasesBuiltInMerge: build_sha null AND no declared file in the merge diff → SKIPPED so the phase's build session can still auto-queue (the fold-deadlock fix)", () => {
  const v = pickPhasesBuiltInMerge([P2_UNBUILT], new Set(["src/lib/unrelated.ts"]));
  assert.deepEqual(v.stamped, []);
  assert.deepEqual(v.skipped, [2]);
});

test("pickPhasesBuiltInMerge: mergedFiles=null (GitHub read failure) → collapses to build_sha-only; the built phase still stamps, unbuilt phases skip (no over-stamp on a hiccup)", () => {
  const v = pickPhasesBuiltInMerge([P1_BUILT, P2_UNBUILT, P3_UNBUILT], null);
  assert.deepEqual(
    v.stamped.map((s) => s.position),
    [1],
    "only P1 (with build_sha) is stamped — no path fallback available",
  );
  assert.deepEqual(v.skipped, [2, 3]);
});

test("pickPhasesBuiltInMerge: empty phases → empty stamped + skipped (no-op)", () => {
  const v = pickPhasesBuiltInMerge([], new Set(["anything"]));
  assert.deepEqual(v.stamped, []);
  assert.deepEqual(v.skipped, []);
});

test("pickPhasesBuiltInMerge: a phase whose body names paths NONE of which are in the merge diff, with build_sha null → SKIPPED (never stamp on prose alone)", () => {
  const phase: PhaseBuiltCandidate = {
    position: 4,
    build_sha: null,
    body: "Ships `src/lib/a.ts` and `src/lib/b.ts`.",
  };
  const v = pickPhasesBuiltInMerge([phase], new Set(["src/lib/c.ts"]));
  assert.deepEqual(v.stamped, []);
  assert.deepEqual(v.skipped, [4]);
});

test("pickPhasesBuiltInMerge: build_sha set wins even when merge diff is empty — the worker's branch-build stamp is the primary truth (don't require file intersection when we already know the branch built it)", () => {
  const v = pickPhasesBuiltInMerge([P1_BUILT], new Set());
  assert.equal(v.stamped.length, 1);
  assert.equal(v.stamped[0].reason, "build_sha");
});

// ── isMergeShaAncestorOfMain — reverse-drift-verify-merge-sha-on-main… Phase 1 ─────────────────
//
// The reverse-drift pre-filter was escalating just-merged phases as 'code-missing' because its
// symbol grep uses GitHub's eventually-consistent `/search/code` index — a fresh merge lags the
// index by minutes-to-hours, so the grep returned empty and the phase was flagged as a possible
// revert to the CEO inbox (the lf8-live-ad-gate incident). The fix consults the IMMEDIATELY-
// consistent `/compare/{merge_sha}...main` API BEFORE escalation. This pure helper classifies
// the API's `status` field; the async wrapper (`mergeShaOnMain`) fetches it. Verification bullet
// "the check uses the commits/compare API, not the laggy search index" is testable here without
// mocking DB or GitHub — the whole classify decision lives in this one string→bool function.

test("isMergeShaAncestorOfMain: status 'ahead' → true (main is ahead of merge_sha → merge_sha shipped)", () => {
  assert.equal(isMergeShaAncestorOfMain("ahead"), true);
});

test("isMergeShaAncestorOfMain: status 'identical' → true (main IS merge_sha — hasn't moved past the merge yet)", () => {
  assert.equal(isMergeShaAncestorOfMain("identical"), true);
});

test("isMergeShaAncestorOfMain: status 'behind' → false (main is BEHIND merge_sha — merge_sha not reachable from main)", () => {
  // Shouldn't happen for a real merge, but the classifier must not accidentally green-light it.
  assert.equal(isMergeShaAncestorOfMain("behind"), false);
});

test("isMergeShaAncestorOfMain: status 'diverged' → false (merge_sha lives on a discarded branch)", () => {
  // This is the REAL revert shape — the phase's shipping commit was later removed from main
  // (a hard reset / a revert-of-revert / a force-push). MUST escalate — never suppressed.
  assert.equal(isMergeShaAncestorOfMain("diverged"), false);
});

test("isMergeShaAncestorOfMain: an unrecognised status string → false (fail-closed on unexpected payloads)", () => {
  // A future GitHub API change or a garbled response falls through to escalation, never a
  // silent auto-resolve.
  assert.equal(isMergeShaAncestorOfMain("wat"), false);
});

test("isMergeShaAncestorOfMain: null / undefined → false (missing payload never green-lights the short-circuit)", () => {
  assert.equal(isMergeShaAncestorOfMain(null), false);
  assert.equal(isMergeShaAncestorOfMain(undefined), false);
});

test("isMergeShaAncestorOfMain: the merge_sha-on-main short-circuit (the spec's core assertion) — a phase whose merge_sha is on main is NOT escalated even when the search grep returns empty; a phase whose merge_sha is absent from main STILL escalates", () => {
  // Simulates the two verdicts the pre-filter derives from this helper right before its
  // code-missing return. This mirrors the fall-through logic in `driftPreFilterPhase`:
  //
  //   onMain(status) === true  → return code-present (auto-resolve — do NOT escalate)
  //   onMain(status) === false → fall through to the existing code-missing escalation
  //
  // The two rows below pin both directions on the SAME symbol-grep-empty premise (the very
  // condition the spec calls out) so a regression that flips one flips the other too.
  const shipped: Array<{ status: string; escalate: boolean }> = [
    { status: "ahead", escalate: false }, // merge landed on main → code shipped → NOT escalated
    { status: "identical", escalate: false }, // main IS merge_sha → NOT escalated
    { status: "diverged", escalate: true }, // real revert → STILL escalates
    { status: "behind", escalate: true }, // not reachable from main → STILL escalates
  ];
  for (const s of shipped) {
    const onMain = isMergeShaAncestorOfMain(s.status);
    // Callsite semantics: `code-missing` is escalated iff the merge_sha is NOT on main.
    const wouldEscalate = !onMain;
    assert.equal(
      wouldEscalate,
      s.escalate,
      `status '${s.status}' should ${s.escalate ? "escalate" : "auto-resolve"} — regression`,
    );
  }
});
