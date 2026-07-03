// _verify-pulse-synthesis — the Phase-2 pure-code verification harness for
// founder-pulse. NO LLM call: imports synthesizeDeterministic + feeds it
// fixture digests and asserts the shape of the resulting snapshot.
//
// docs/brain/specs/founder-pulse.md Phase 2 verification requires:
//  (a) all five lenses present,
//  (b) every surfaced claim has ≥1 non-empty cite,
//  (c) the folded-spec thread appears as resolved/'what's working' and NOT
//      under 'where you left off',
//  (d) the open thread DOES appear under 'where you left off'
//
// Run:
//   npx tsx scripts/_verify-pulse-synthesis.ts
import "./_bootstrap";
import { LENS_KEYS, synthesizeDeterministic, type DigestInput } from "../src/lib/pulse";
import type { SpecRow, SpecPhaseRow } from "../src/lib/specs-table";

function makeSpec(partial: Partial<SpecRow> & { slug: string; title: string; phases?: SpecPhaseRow[] }): SpecRow {
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
    merged_pr: null,
    last_merge_sha: null,
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

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const foldedSpec = makeSpec({ slug: "founder-pulse-recap", title: "Founder pulse recap", status: "folded" });
  const openSlug = "next-big-thing"; // no matching spec at all — the "genuinely open" thread
  const digests: DigestInput[] = [
    {
      id: "d-1",
      session_id: "4e303b13",
      intent: "Wire up the founder-pulse recap.",
      resume_point: "Left off after the recap ship.",
      last_activity_at: "2026-07-01T12:00:00Z",
      decisions: [],
      threads: [{ title: "founder-pulse-recap", status: "open", cite: "we shipped this" }],
      refs: [],
    },
    {
      id: "d-2",
      session_id: "a1b2c3d4",
      intent: "Sketching the next-big-thing surface.",
      resume_point: "Still deciding whether to invest.",
      last_activity_at: "2026-07-02T15:00:00Z",
      decisions: [],
      threads: [{ title: openSlug, status: "open", cite: "no spec yet" }],
      refs: [],
    },
  ];

  const snap = synthesizeDeterministic({ digests, specs: [foldedSpec], jobs: [] });

  console.log("Assertions:");
  // (a) all five lenses present
  for (const k of LENS_KEYS) {
    assert(Array.isArray(snap.lenses[k]), `lens ${k} present as an array`);
  }
  // (b) every claim has ≥1 non-empty cite
  for (const k of LENS_KEYS) {
    for (const c of snap.lenses[k]) {
      assert(
        Array.isArray(c.cite_ids) && c.cite_ids.length > 0 && c.cite_ids.every((id) => typeof id === "string" && id.length > 0),
        `lens ${k}: claim "${c.claim.slice(0, 40)}…" has ≥1 non-empty cite`,
      );
      for (const id of c.cite_ids) {
        assert(snap.cites[id], `cite id ${id} is registered in snapshot.cites`);
      }
    }
  }
  // (c) folded-spec thread is in whats_working AND NOT in where_you_left_off
  const wwSlugMentions = snap.lenses.whats_working
    .map((c) => c.claim.toLowerCase())
    .join(" | ");
  assert(wwSlugMentions.includes("founder pulse recap") || wwSlugMentions.includes("founder-pulse-recap"), "folded-spec thread surfaces under whats_working");
  const wlSlugMentions = snap.lenses.where_you_left_off
    .map((c) => c.claim.toLowerCase())
    .join(" | ");
  assert(!wlSlugMentions.includes("founder-pulse-recap"), "folded-spec thread does NOT appear under where_you_left_off");

  // (d) open thread with no matching spec DOES appear under where_you_left_off
  assert(wlSlugMentions.includes(openSlug), "open (unmatched) thread appears under where_you_left_off");

  console.log("\n✅ pulse-synthesis verification passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
