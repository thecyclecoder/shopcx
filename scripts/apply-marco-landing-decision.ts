/**
 * marco-logistics-director-seat Phase 1 — stamp the A-vs-B landing DECISION into the
 * `spec_phases.metadata` bag of the spec's Phase 1 row, so Phase 3's build gate can read it.
 *
 * Decision: **B (read-only observer)**. Evidence gathered in the Phase 1 investigation:
 *  1. Storefront-availability toggle has NO callable server-side helper — `crisis-forecast.ts:187`
 *     only describes the play in prose ("Pull SL OFF the storefront + portal options"); no
 *     `toggleStorefrontAvailability` / `setStorefrontAvailability` exists across `src/`.
 *  2. Auto-re-add / swap-enrollment writer DOES exist as a callable executor:
 *     `action-executor.ts` `crisis_enroll` + `crisis_set_auto_readd` (both mutate
 *     `crisis_customer_actions.auto_readd`). This satisfies half of Phase 1's rubric.
 *  3. `docs/brain/functions/logistics.md:40` § "Provenance / build model" EXPLICITLY flags this
 *     whole tooling as off-limits to Ada:
 *       "Kept off `public.specs` by founder directive (2026-07-10) — no devops operation. This is
 *        a deliberate, bounded exception to 'Ada is the sole builder'; general doctrine unchanged."
 *
 * Any ONE of (1)/(3) missing already forces B; both point to B. Ada (the builder) MUST NOT wire
 * executors that reach into a founder-driven surface. Phase 3 builds Marco read-only with a
 * follow-up spec `marco-logistics-executor-surface` authored via the specs-table SDK.
 *
 * Run against the pooler:
 *   npx tsx scripts/apply-marco-landing-decision.ts
 */
import "./_bootstrap";
import { setPhaseMetadata, getSpec } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "marco-logistics-director-seat";

async function main() {
  const spec = await getSpec(WS, SLUG);
  if (!spec) {
    console.error(`✗ no spec row for slug='${SLUG}' in workspace ${WS} — nothing to stamp`);
    process.exit(1);
  }
  const phase1 = (spec.phases ?? []).find((p) => p.position === 1);
  if (!phase1) {
    console.error(`✗ no spec_phases row at position=1 for '${SLUG}' — nothing to stamp`);
    process.exit(1);
  }

  await setPhaseMetadata(WS, SLUG, 1, {
    marco_landing: "B",
    decided_at: new Date().toISOString(),
    reasoning:
      "Availability-toggle has no callable server-side helper (crisis-forecast.ts:187 is prose); " +
      "crisis_enroll/crisis_set_auto_readd exist as callable executors in action-executor.ts; " +
      "logistics.md § 'Provenance / build model' explicitly flags this whole tooling as off-limits " +
      "to Ada (kept off public.specs by founder directive 2026-07-10, deliberate exception to " +
      "'Ada is the sole builder'). Landing shape B: Marco ships as read-only observer + a " +
      "follow-up spec marco-logistics-executor-surface is authored in Phase 3.",
  });

  const after = await getSpec(WS, SLUG);
  const p1 = (after?.phases ?? []).find((p) => p.position === 1);
  const stamped = (p1?.metadata as { marco_landing?: string } | null | undefined)?.marco_landing;
  if (stamped !== "B") {
    console.error(`✗ stamp verification failed — metadata.marco_landing = ${JSON.stringify(stamped)}`);
    process.exit(1);
  }
  console.log(`✓ stamped ${SLUG} phase 1 metadata.marco_landing = 'B'`);
}
main().catch((e) => { console.error(e); process.exit(1); });
