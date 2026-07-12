// marco-logistics-director-seat Phase 3 — author the follow-up spec that opens Marco's
// autonomous surface once the founder-driven inventory build model matures.
//
// Marco lands READ-ONLY in Phase 3 (decision B from Phase 1: the availability-toggle has no
// callable server-side helper, and docs/brain/functions/logistics.md § "Provenance / build model"
// flags the whole tooling as off-limits to Ada by founder directive 2026-07-10). This planned
// spec captures the executor slice as a legible, queued piece of work — an owner (logistics),
// a parent (the current milestone the goal is decomposing), and two phase-bodies naming the
// executors Marco's future LEASH_CATEGORIES would open onto.
//
// Run against the pooler:
//   npx tsx scripts/_author-marco-logistics-executor-surface-spec.ts
import "./_bootstrap";
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WS,
    "marco-logistics-executor-surface",
    {
      title: "Marco / Logistics executor surface — open the two crisis-cohort levers to autonomous action",
      why:
        "Marco (Logistics) currently lands read-only in the Message Center — his LEASH_CATEGORIES is intentionally empty because the storefront-availability toggle has no callable server-side helper and the founder is hand-driving the whole inventory-allocation surface. See docs/brain/functions/logistics.md § 'Provenance / build model' (kept off public.specs by founder directive 2026-07-10, deliberate bounded exception to 'Ada is the sole builder'). When the founder opens the tooling to Ada, this spec is the queued piece of work that turns Marco into the fourth live leash-bound director — availability_toggle_within_crisis_lever + auto_readd_swapped_subscribers_within_crisis_cohort become callable, and Marco's coach thread starts emitting pending_action cards the CEO can approve.",
      what:
        "Two artifacts: (1) a callable server-side helper `setStorefrontAvailability(variantId, available: boolean, reason: string)` that idempotently drives the Shopify storefront availability + portal swap options (the play at crisis-forecast.ts:187 currently described in prose); (2) `src/lib/agents/logistics-director.ts` LEASH_CATEGORIES gains `availability_toggle_within_crisis_lever` + `auto_readd_swapped_subscribers_within_crisis_cohort`, director-leash-guide.ts CATEGORY_COPY gets the plain-English pair, the M3 dispatch in scripts/builder-worker.ts adds the two executor branches (calling setStorefrontAvailability + crisis_set_auto_readd), and directorCoachFraming for logistics emits the two new card shapes. When shipped, the M2 Message Center Marco tab picks him up as a live director (function_autonomy.live flipped true), and a Marco thread issuing an availability-toggle action approves through /api/director/coach and lands one director_activity row with director_function='logistics'.",
      summary:
        "Follow-up spec surfaced by marco-logistics-director-seat Phase 3 (decision B, read-only observer landing). Unblocks: the founder opening the inventory build model to Ada — until then, this spec stays planned and Marco stays read-only.",
      owner: "logistics",
      parent: "[[../functions/logistics]] § Crisis-aware replenishment & allocation (the Marco doctrine) — opens the two levers Logistics.md already documents to autonomous action once the founder-driven build model matures.",
      blocked_by: ["marco-logistics-director-seat"],
      phases: [
        {
          title: "Callable setStorefrontAvailability helper (retires the prose-only availability lever)",
          why: "The availability lever at crisis-forecast.ts:187 is described in prose ('Pull SL OFF the storefront + portal options') but has no callable executor — every toggle currently requires a manual Shopify theme edit. Without a callable helper, Marco's director dispatch cannot invoke it, so this is the load-bearing prereq.",
          what: "Author `setStorefrontAvailability(variantId, available: boolean, reason: string)` in `src/lib/logistics/` (co-located with crisis-forecast.ts + cover.ts). Idempotent (no-op if the variant already carries the target state); writes both the Shopify storefront availability + the portal swap options table (docs/brain/tables/…) via the sanctioned SDKs; records a director_activity-friendly audit row naming the reason.",
          status: "planned",
          body: "Add `src/lib/logistics/storefront-availability.ts` exporting `setStorefrontAvailability(variantId, available, reason)`. The function loads the variant, computes the target Shopify storefront-availability state + portal swap-option state, executes both via the existing shopify-theme + portal-config SDKs, and records an audit row. Idempotent + safe to re-run. Unit test pins: available=true → both storefronts show the variant; available=false → both hide; a repeat call is a no-op.",
          verification:
            "On `npx tsx scripts/_probe-storefront-availability.ts <variant-id>` before + after `setStorefrontAvailability(<variant-id>, false, 'test')` → expect the variant's Shopify availability + portal option to be OFF, and the audit row to carry the reason. A second call is a no-op (no double-write to Shopify).",
        },
        {
          title: "Open logistics LEASH_CATEGORIES + wire the two executor branches",
          why: "Once the helper is callable, Marco can be flipped from read-only observer to live leash-bound director. This is the actual seat-change: LEASH_CATEGORIES gets the two categories, director-leash-guide picks them up, the M3 dispatch adds the executor branches, and the coach framing emits the two cards.",
          what: "Edit `src/lib/agents/logistics-director.ts`: `LEASH_CATEGORIES: LeashCategory[] = ['availability_toggle_within_crisis_lever', 'auto_readd_swapped_subscribers_within_crisis_cohort']`, drop the READ_ONLY marker. Edit `src/lib/agents/director-leash-guide.ts`: add two CATEGORY_COPY entries pairing plain-English titles + details for the CEO Guide tab. Edit `scripts/builder-worker.ts` M3 dispatch: add `availability_toggle_within_crisis_lever` + `auto_readd_swapped_subscribers_within_crisis_cohort` to the logistics Set + the two executor branches (calling `setStorefrontAvailability` + `crisis_set_auto_readd` respectively; both write a `director_activity` row with `director_function='logistics'`). Edit `directorCoachFraming` for logistics to emit the two new card shapes (retire the read-only-observer text). Update `docs/brain/functions/logistics.md` Status section: read-only → live leash-bound.",
          status: "planned",
          body: "See What. Coach framing carries the two card shapes: `availability_toggle_within_crisis_lever` (payload: variant_id + available + reason + crisis_id) and `auto_readd_swapped_subscribers_within_crisis_cohort` (payload: crisis_id + reason). Both actions verify a same-workspace crisis row on the payload before executing (the crisis-cohort guard).",
          verification:
            "On `psql -c \"select * from function_autonomy where function_slug='logistics'\"` after the CEO flips live/autonomous true → expect the row live=true autonomous=true. On `GET /api/developer/agents/guide?slug=logistics` → expect `defined:true` with two autonomous lines matching the LOGISTICS CATEGORY_COPY. On a logistics director-coach thread issuing an `availability_toggle_within_crisis_lever` action approved via `POST /api/director/coach action=approve` → expect `setStorefrontAvailability` to run once and one `director_activity` row with `director_function='logistics'`. On a Growth card leaking into a logistics thread → expect escalation via `escalateApprovalRequestToCeo` + no inventory mutation (the cross-director rail).",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "logistics" },
  );
  console.log(ok ? "authored marco-logistics-executor-surface" : "author failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
