/**
 * Fold the 3 commerce-SDK-inventory watch-items into the plan tree WITHOUT re-running Pia:
 *  1. commerce-sdk-migrate-ticket-detail  — add the missing ticket actions (change_frequency,
 *     switch_payment_method) to Phase 3 acceptance.
 *  2. commerce-sdk-migrate-dashboard-agent-ai — add sub-detail apply-coupon, the crisis "Resolve"
 *     stub fix, and fraud confirm-fraud transactionality to Phase 1 acceptance.
 *  3. NEW standalone spec loyalty-list-stats-and-adjust-guard under M4 (authored via the chokepoint).
 *
 * Edits go through upsertSpec (specs-table SDK) passing the FULL existing row back verbatim so
 * milestone_id / blocked_by / parent / vale state are preserved (upsertSpec nulls milestone_id if
 * omitted). The new spec goes through authorSpecRowStructured (chokepoint → lands in_review for Vale).
 *
 * Run: npx tsx scripts/_amend-commerce-specs.ts        (dry)
 *      APPLY=1 npx tsx scripts/_amend-commerce-specs.ts (writes)
 */
import "./_bootstrap";
import { getSpec, upsertSpec, type SpecRowInput, type SpecPhaseInput } from "../src/lib/specs-table";
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const M4 = "6a5e6b75-75d2-44a6-bec3-ffb93f90620e";
const M4_PARENT = "M4 — Migrate internal surfaces (dashboard + agent + AI)";
const APPLY = process.env.APPLY === "1";

// Rebuild the full row input verbatim from an existing spec (status omitted → preserved).
function rowFrom(s: any): SpecRowInput {
  return {
    slug: s.slug, title: s.title, summary: s.summary, owner: s.owner,
    parent: s.parent, blocked_by: s.blocked_by ?? [], priority: s.priority,
    deferred: s.deferred, intended_status: s.intended_status,
    intended_status_set_by: s.intended_status_set_by,
    repair_signature: s.repair_signature,
    regression_of_slug: s.regression_of_slug,
    regression_signature: s.regression_signature,
    related_spec: s.related_spec,
    auto_build: s.auto_build,
    milestone_id: s.milestone_id, // CRITICAL: preserve the milestone link
    why: s.why, what: s.what,
    parent_kind: s.parent_kind, parent_ref: s.parent_ref,
    // status: OMITTED → preserved (in_review derived)
  };
}

// Rebuild phases verbatim; for the target position, append text to its verification.
function phasesWith(s: any, targetPos: number, appendVerification: string): SpecPhaseInput[] {
  return (s.phases ?? []).map((p: any): SpecPhaseInput => ({
    position: p.position,
    title: p.title,
    body: p.body,
    status: "planned", // all unbuilt; stored status is override-only + re-derived on read
    verification: p.position === targetPos ? `${p.verification ?? ""}${appendVerification}` : p.verification,
    // why/what/kind/pr/merge_sha OMITTED → preserved
  }));
}

const TICKET_APPEND =
  "\n- On the ticket-detail surface post-migration, expect the previously-MISSING subscription actions " +
  "`change_frequency` and `switch_payment_method` to be EXPOSED and routed through commerce Mutation ops " +
  "(the migration ADDS them — it does not only re-point the actions that already existed). " +
  "[commerce-sdk-inventory watch-item]";

const DASH_APPEND =
  "\n- On the dashboard subscription-detail page, expect Apply Coupon to be EXPOSED (today it is remove-only) " +
  "and routed through the internal-aware commerce coupon op." +
  "\n- On the Crisis \"Resolve\" action, expect it to EXECUTE its promised subscription side-effects " +
  "(auto-resume paused subs + re-add removed items) via commerce Mutation ops — not merely flip " +
  "`crisis_events.status` to 'resolved' (today's stub)." +
  "\n- On the fraud confirm-fraud flow, expect the compound customer/order/subscription writes to be " +
  "transactional or resumable (idempotent, all-or-nothing) so a partial failure never leaves mixed state. " +
  "[commerce-sdk-inventory watch-items]";

async function editSpec(slug: string, targetPos: number, append: string) {
  const s = await getSpec(WS, slug);
  if (!s) { console.error(`  ✗ ${slug} not found`); return; }
  console.log(`\n• ${slug}: append ${append.split("\\n- ").length - 1 || 1} criteria to Phase ${targetPos} (milestone_id=${(s as any).milestone_id}, blocked_by=${JSON.stringify(s.blocked_by)})`);
  if (!APPLY) return;
  await upsertSpec(WS, rowFrom(s), phasesWith(s, targetPos, append));
  const after = await getSpec(WS, slug);
  console.log(`  ✓ written. milestone_id=${(after as any).milestone_id} blocked_by=${JSON.stringify(after!.blocked_by)} phases=${after!.phases.length}`);
}

async function authorLoyalty() {
  const slug = "loyalty-list-stats-and-adjust-guard";
  const existing = await getSpec(WS, slug);
  console.log(`\n• ${slug}: ${existing ? "exists — skip" : "author NEW under M4"}`);
  if (existing || !APPLY) return;
  const ok = await authorSpecRowStructured(
    WS, slug,
    {
      title: "Loyalty: program-wide stats + negative-balance guard on manual adjust",
      summary:
        "Two loyalty defects surfaced by the commerce-SDK inventory (docs/brain/reference/commerce-sdk-inventory.html), " +
        "orthogonal to the SDK migration: (1) the loyalty LIST stats (Points Outstanding / Total Earned / Avg) are " +
        "summed over a 250-row sample in src/app/dashboard/loyalty/page.tsx but labeled program-wide, so they are wrong " +
        "for any workspace with >250 members; (2) the manual point-adjustment route writes raw, bypassing the guarded " +
        "src/lib/loyalty.ts deductPoints path, with no negative-balance guard.",
      owner: "platform",
      parent: M4_PARENT,
      blocked_by: [],
      why:
        "Live customer-data-correctness bugs: operators see wrong loyalty totals for any workspace over 250 members, " +
        "and a large negative manual adjustment can drive a member's points_balance below zero.",
      what:
        "Loyalty list stats are computed program-wide (server-side SQL aggregate over all loyalty_members, not a 250-row " +
        "JS sample), and manual point adjustment goes through the guarded loyalty.ts helpers so a balance can never go negative.",
      phases: [
        {
          title: "Phase 1 — Program-wide loyalty stats",
          body:
            "Replace the client-side 250-row sample aggregation in src/app/dashboard/loyalty/page.tsx (Points Outstanding / " +
            "Total Earned / Avg Points) with a program-wide aggregate computed server-side (a SQL SUM/AVG / RPC over ALL " +
            "loyalty_members for the workspace). The average's denominator uses the true member total, not the sample size.",
          verification:
            "- On a workspace with >250 loyalty members, expect Points Outstanding + Total Earned + Avg Points to equal a " +
            "direct SQL SUM/AVG over all loyalty_members, not the top-250 sample.\n" +
            "- On the loyalty list data path, expect no client-side sum over a capped fetch.",
          why: "The stats are labeled program-wide but computed over a 250-row sample, so they mislead operators past 250 members.",
          what: "The three loyalty list stats are correct for any member count.",
        },
        {
          title: "Phase 2 — Guarded manual adjustment",
          body:
            "Route the manual point-adjustment endpoint (src/app/api/loyalty/members/[memberId]/route.ts) through the guarded " +
            "deductPoints / earnPoints helpers in src/lib/loyalty.ts instead of a raw loyalty_transactions insert + " +
            "loyalty_members update, and reject (or clamp to 0) any adjustment that would drive points_balance below zero.",
          verification:
            "- On a manual adjustment larger than the member's balance, expect a 4xx (or a clamp to 0) — never a negative points_balance.\n" +
            "- On grep of the members/[memberId] route, expect it calls the loyalty.ts helpers, not a raw .from('loyalty_transactions').insert.",
          why: "The raw-write adjustment path bypasses the guarded helper and can push a balance negative.",
          what: "Manual adjustments are guarded and can never produce a negative balance.",
        },
      ],
    },
    "planned",
    { milestoneId: M4, parentKind: "milestone", parentRef: M4, intendedStatusSetBy: "founder-inventory-followup" },
  );
  console.log(ok ? "  ✓ authored (in_review)" : "  ✗ authorSpecRowStructured returned false — gate failed");
}

async function main() {
  console.log(APPLY ? "APPLY" : "DRY RUN");
  await editSpec("commerce-sdk-migrate-ticket-detail", 3, TICKET_APPEND);
  await editSpec("commerce-sdk-migrate-dashboard-agent-ai", 1, DASH_APPEND);
  await authorLoyalty();
  if (!APPLY) console.log("\nset APPLY=1 to write.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
