/**
 * Refines the authored bianca-cold-test-recent-purchaser-exclusion spec per founder direction:
 *   (1) pixel purchaser audience 90d → 180d (Meta's max retention),
 *   (2) drop the blocked_by gate on the measurement spec (founder ACCEPTED the overlap
 *       hypothesis — 15.8% blended, Superfood Tabs 60%; measurement stays a monitor, not a gate),
 *   (3) note the full-order-history customer-list audience ships as a sibling spec that composes
 *       into the SAME excluded_custom_audiences list.
 * Reads the existing spec and TRANSFORMS in place (never hand-retypes Pia's phase text).
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec, upsertSpec } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "bianca-cold-test-recent-purchaser-exclusion";

// Only "90" literals in these phases are the retention window (verified against the dumped text) —
// a global 90→180 on the phase text is safe.
const bump = (s: string | null | undefined): string | null =>
  s == null ? (s as null) : s.replace(/90/g, "180");

async function main() {
  const s: any = await getSpec(WS, SLUG);
  if (!s) throw new Error("spec not found");

  const phases = (s.phases || []).map((p: any) => ({
    position: p.position,
    title: bump(p.title)!,
    body: bump(p.body)!,
    status: p.status || "planned",
    why: bump(p.why),
    what: bump(p.what),
    verification: bump(p.verification),
    // preserve pr/merge_sha by omitting (undefined = preserve)
  }));

  const newSummary =
    (s.summary || "").replace(/90/g, "180") +
    "\n\n**Refinement (founder 2026-07-15):** pixel purchaser audience is 180d (Meta max). This is ONE of two exclusion audiences composed into the same targeting.excluded_custom_audiences list — the other, a customer-list custom audience built from our ENTIRE order history (all 3 sources, hashed, refreshed), ships as sibling spec [[bianca-full-order-history-customer-list-exclusion-audience]] (reuses this spec's plumbing). Gate dropped: the overlap measurement is a monitor, not a build-gate (founder accepted the hypothesis — 15.8% blended, Superfood Tabs 60%).";

  const res = await upsertSpec(
    WS,
    {
      slug: SLUG,
      title: s.title,
      summary: newSummary,
      owner: s.owner,
      parent: s.parent,
      parent_kind: s.parent_kind ?? undefined,
      parent_ref: s.parent_ref ?? undefined,
      blocked_by: [], // drop the gate
      priority: s.priority ?? null,
      deferred: false,
      intended_status: s.intended_status ?? "planned",
      intended_status_set_by: "ceo:dylan",
      auto_build: true,
      milestone_id: s.milestone_id ?? null,
      why: bump(s.why),
      what:
        bump(s.what) +
        " (Founder refinement: pixel window is 180d — Meta's max — and this pixel audience is one of TWO exclusion audiences; the full-order-history customer-list audience composes into the same excluded_custom_audiences list via a sibling spec.)",
    },
    phases,
  );
  console.log("refined spec:", res.spec_id, "phases:", JSON.stringify(res.phase_ids));

  const after: any = await getSpec(WS, SLUG);
  console.log("blocked_by now:", JSON.stringify(after.blocked_by));
  console.log("phase1 title:", after.phases?.[0]?.title);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
