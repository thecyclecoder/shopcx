// _verify-pulse-session-authored — pure-code verification for Phase 3 of
// docs/brain/specs/pulse-session-authored-recaps.md. NO LLM call: imports
// synthesizeDeterministic + feeds it fixture digests/specs and asserts the
// Phase-3 resolution rules hold.
//
// Verification bullets from the spec:
//   - A session-authored thread with a ref kind='pr' value='1160' (merged)
//     renders under what's-working/done, not where-you-left-off.
//   - A no-spec thread with a kind='commit' ref resolves as done.
//   - A thread whose exact-matched spec is later folded flips to resolved on
//     a fresh buildPulse WITHOUT re-ingesting the digest.
//   - The old slug-substring path still works for un-ref'd threads.
//
// Run:
//   npx tsx scripts/_verify-pulse-session-authored.ts
import "./_bootstrap";
import { LENS_KEYS, synthesizeDeterministic, type DigestInput } from "../src/lib/pulse";
import { SESSION_AUTHORED_MODEL } from "../src/lib/pulse-digest";
import type { SpecRow, SpecPhaseRow } from "../src/lib/specs-table";

function makeSpec(partial: Partial<SpecRow> & { slug: string; title: string }): SpecRow {
  return {
    id: `spec-${partial.slug}`,
    workspace_id: "ws-fixture",
    slug: partial.slug,
    title: partial.title,
    summary: null,
    owner: "platform",
    parent: "platform",
    blocked_by: [],
    priority: null,
    deferred: false,
    intended_status: null,
    status: partial.status ?? null,
    intended_status_set_by: null,
    repair_signature: null,
    regression_of_slug: null,
    regression_signature: null,
    auto_build: false,
    vale_pass: null,
    vale_review_passed_at: null,
    ada_disposition: null,
    vale_disposition: null,
    vale_disposition_reason: null,
    milestone_id: null,
    merged_pr: partial.merged_pr ?? null,
    last_merge_sha: partial.last_merge_sha ?? null,
    goal_branch_sha: null,
    why: null,
    what: null,
    parent_kind: null,
    parent_ref: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    phases: partial.phases ?? [],
  };
}

function makePhase(partial: Partial<SpecPhaseRow> & { position: number }): SpecPhaseRow {
  return {
    id: `phase-${partial.position}`,
    spec_id: partial.spec_id ?? "spec-fixture",
    position: partial.position,
    title: partial.title ?? `Phase ${partial.position}`,
    body: partial.body ?? "",
    status: partial.status ?? "planned",
    pr: partial.pr ?? null,
    merge_sha: partial.merge_sha ?? null,
    build_sha: partial.build_sha ?? null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    kind: partial.kind ?? "phase",
    check_keys: partial.check_keys ?? [],
  };
}

function makeDigest(partial: Partial<DigestInput> & { session_id: string }): DigestInput {
  return {
    id: `d-${partial.session_id}`,
    session_id: partial.session_id,
    intent: partial.intent ?? null,
    resume_point: partial.resume_point ?? null,
    last_activity_at: partial.last_activity_at ?? "2026-07-04T12:00:00Z",
    decisions: partial.decisions ?? [],
    threads: partial.threads ?? [],
    refs: partial.refs ?? [],
    digest_model: partial.digest_model ?? null,
  };
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  console.log("Phase-3 assertions:");

  // ── (1) A session-authored thread with a merged-PR ref renders as done ───────────────────────
  // "A session-authored thread with a ref kind='pr' value='1160' (merged) renders under
  //  what's-working/done, not where-you-left-off."
  {
    const shippedSpec = makeSpec({
      slug: "reap-recap",
      title: "Reap the recap",
      phases: [makePhase({ position: 0, pr: 1160, merge_sha: "abc1234def", status: "shipped" })],
    });
    const digest = makeDigest({
      session_id: "sa-pr-1160",
      digest_model: SESSION_AUTHORED_MODEL,
      threads: [{ title: "Pulse recap PR", status: "open", cite: "I opened PR #1160" }],
      refs: [{ kind: "pr", value: "1160" }],
    });
    const snap = synthesizeDeterministic({ digests: [digest], specs: [shippedSpec], jobs: [] });
    const ww = snap.lenses.whats_working.map((c) => c.claim.toLowerCase()).join(" | ");
    const wl = snap.lenses.where_you_left_off.map((c) => c.claim.toLowerCase()).join(" | ");
    assert(ww.includes("reap the recap"), "session-authored + merged-PR ref renders under whats_working");
    assert(!wl.includes("pulse recap pr"), "same thread does NOT appear under where_you_left_off");
  }

  // ── (2) A no-spec thread with a kind='commit' ref resolves as done ───────────────────────────
  // "A no-spec thread with a kind='commit' ref resolves as done." (fixes no-spec-work-stuck-open)
  {
    const digest = makeDigest({
      session_id: "sa-commit",
      digest_model: SESSION_AUTHORED_MODEL,
      threads: [{ title: "Fix the flaky test that had no spec", status: "open", cite: "I pushed the fix" }],
      refs: [{ kind: "commit", value: "deadbeefcafefeed1234" }],
    });
    const snap = synthesizeDeterministic({ digests: [digest], specs: [], jobs: [] });
    const ww = snap.lenses.whats_working.map((c) => c.claim.toLowerCase()).join(" | ");
    const wl = snap.lenses.where_you_left_off.map((c) => c.claim.toLowerCase()).join(" | ");
    assert(ww.includes("deadbee") || ww.includes("flaky test"), "no-spec + commit-sha ref renders under whats_working");
    assert(!wl.includes("flaky test that had no spec"), "same thread does NOT appear under where_you_left_off");
  }

  // ── (3) Post-session shipping flips a thread to resolved WITHOUT re-ingesting the digest ──
  // "A thread whose exact-matched spec is later folded flips to resolved on a fresh buildPulse
  //  WITHOUT re-ingesting the digest."
  // Simulated: build TWO snapshots from the SAME digest — first with a planned spec (thread → open),
  // then with the same spec flipped to folded (thread → resolved). No digest mutation between runs.
  {
    const digest = makeDigest({
      session_id: "sa-flip",
      digest_model: SESSION_AUTHORED_MODEL,
      threads: [{ title: "Reconciliation spec", status: "open", cite: "we planned this" }],
      refs: [{ kind: "spec", value: "reconcile-keys" }],
    });
    const plannedSpec = makeSpec({ slug: "reconcile-keys", title: "Reconciliation keys" });
    const foldedSpec = makeSpec({ slug: "reconcile-keys", title: "Reconciliation keys", status: "folded" });

    const before = synthesizeDeterministic({ digests: [digest], specs: [plannedSpec], jobs: [] });
    const wlBefore = before.lenses.where_you_left_off.map((c) => c.claim.toLowerCase()).join(" | ");
    assert(wlBefore.includes("reconciliation spec"), "before-shipping: thread appears under where_you_left_off");

    const after = synthesizeDeterministic({ digests: [digest], specs: [foldedSpec], jobs: [] });
    const wwAfter = after.lenses.whats_working.map((c) => c.claim.toLowerCase()).join(" | ");
    const wlAfter = after.lenses.where_you_left_off.map((c) => c.claim.toLowerCase()).join(" | ");
    assert(wwAfter.includes("reconciliation keys"), "after-shipping: same digest re-renders as whats_working");
    assert(!wlAfter.includes("reconciliation spec"), "after-shipping: thread NO LONGER in where_you_left_off");
  }

  // ── (4) The old slug-substring path still works for un-ref'd threads ─────────────────────────
  // "The old slug-substring path still works for un-ref'd threads."
  {
    const foldedSpec = makeSpec({ slug: "founder-pulse-recap", title: "Founder pulse recap", status: "folded" });
    const digest = makeDigest({
      session_id: "haiku-substring",
      digest_model: "claude-haiku-4-5-20251001",
      threads: [{ title: "founder-pulse-recap wire-up", status: "open", cite: "we shipped it" }],
      refs: [], // no exact refs — fallback slug-substring path must catch this
    });
    const snap = synthesizeDeterministic({ digests: [digest], specs: [foldedSpec], jobs: [] });
    const ww = snap.lenses.whats_working.map((c) => c.claim.toLowerCase()).join(" | ");
    assert(ww.includes("founder pulse recap"), "slug-substring fallback still resolves un-ref'd threads");
  }

  // Sanity: all five lenses still shape-correctly.
  const combined = synthesizeDeterministic({ digests: [], specs: [], jobs: [] });
  for (const k of LENS_KEYS) {
    assert(Array.isArray(combined.lenses[k]), `lens ${k} present as an array on an empty snapshot`);
  }

  console.log("\n✅ pulse-session-authored Phase 3 verification passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
