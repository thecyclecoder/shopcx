// wire-blueprint-lander-experiment — Phase 2 apply script for the "build the
// {slug} lander" spec chain. For a shipped [[lander_blueprints]] row, stand
// up the baseline [[storefront_experiments]] row so the storefront-optimizer +
// campaign-grader see the new lander as a candidate surface. The row lands at
// status='draft' (idempotent; a re-run against an already-wired blueprint is
// a no-op) — the founder promotes it to 'running' from the dashboard once the
// render QA passes.
//
// Two-phase — dry-run by default; --apply mutates:
//   npx tsx scripts/wire-blueprint-lander-experiment.ts                # dry-run: preview the write
//   npx tsx scripts/wire-blueprint-lander-experiment.ts --apply        # actually insert
//   npx tsx scripts/wire-blueprint-lander-experiment.ts <blueprint-id> # override the default id
//
// The DEFAULT blueprint id is baked in for the amazing-coffee advertorial-listicle
// build (docs/brain/specs/lander-build-advertorial-listicle-amazing-coffee-23e0ea01.md).
// Pass a positional id to wire a different blueprint (used by later builds off
// the same spec chain).
import { createAdminClient } from "./_bootstrap";
import {
  wireBlueprintExperiment,
  BLUEPRINT_BASELINE_LEVER,
} from "../src/lib/blueprint-experiment-wiring";
import { mapFunnelTypeToLanderType } from "../src/lib/cleo-blueprint";

const DEFAULT_BLUEPRINT_ID = "23e0ea01-fea1-4aa2-90f3-bad2d856f654";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const blueprintId = args.find((a) => !a.startsWith("--")) || DEFAULT_BLUEPRINT_ID;

  const admin = createAdminClient();
  const { data: bp, error } = await admin
    .from("lander_blueprints")
    .select("id, workspace_id, product_id, funnel_type, status, build_spec_slug, content")
    .eq("id", blueprintId)
    .maybeSingle();
  if (error) throw new Error(`blueprint read failed: ${error.message}`);
  if (!bp) throw new Error(`blueprint ${blueprintId} not found`);

  const contentBlocks = Array.isArray(bp.content?.blocks) ? bp.content.blocks.length : 0;
  const landerType = mapFunnelTypeToLanderType(bp.funnel_type);
  console.log("blueprint:");
  console.log(`  id            ${bp.id}`);
  console.log(`  workspace_id  ${bp.workspace_id}`);
  console.log(`  product_id    ${bp.product_id}`);
  console.log(`  funnel_type   ${bp.funnel_type} → lander_type=${landerType ?? "(unmapped)"}`);
  console.log(`  status        ${bp.status}`);
  console.log(`  content       ${contentBlocks} blocks`);
  console.log(`  build_spec    ${bp.build_spec_slug ?? "(none)"}`);
  console.log("");

  if (!landerType) {
    console.error(
      `refusing to wire: funnel_type='${bp.funnel_type}' doesn't map to a known lander_type`,
    );
    process.exit(1);
  }
  if (contentBlocks === 0) {
    console.error(
      `refusing to wire: blueprint content isn't filled (0 blocks) — Carrie's dr-content pass hasn't run to completion`,
    );
    process.exit(1);
  }

  const { data: existing } = await admin
    .from("storefront_experiments")
    .select("id, status, created_at")
    .eq("workspace_id", bp.workspace_id)
    .eq("product_id", bp.product_id)
    .eq("lander_type", landerType)
    .eq("lever", BLUEPRINT_BASELINE_LEVER)
    .limit(1)
    .maybeSingle();

  if (existing) {
    console.log(
      `already wired: storefront_experiments ${existing.id} (status=${existing.status}, created_at=${existing.created_at}) — nothing to do`,
    );
    return;
  }

  console.log("plan:");
  console.log(`  INSERT storefront_experiments`);
  console.log(`    (workspace_id=${bp.workspace_id}, product_id=${bp.product_id},`);
  console.log(`     lander_type=${landerType}, audience=all, lever=${BLUEPRINT_BASELINE_LEVER},`);
  console.log(`     status=draft, holdout_pct=0.10, hypothesis=<blueprint-derived>)`);
  console.log(`  INSERT storefront_experiment_variants (control, is_control=true, patch={})`);
  console.log("");

  if (!apply) {
    console.log("[dry-run] pass --apply to actually insert.");
    return;
  }

  const outcome = await wireBlueprintExperiment({
    workspaceId: bp.workspace_id,
    blueprintId: bp.id,
    createdBy: "wire-blueprint-lander-experiment.ts",
  });
  if (!outcome.ok) {
    console.error(`FAILED: ${outcome.detail}`);
    process.exit(1);
  }
  console.log(`✓ ${outcome.detail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
