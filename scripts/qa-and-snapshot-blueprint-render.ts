// qa-and-snapshot-blueprint-render — Phase 3 QA + rendered-URL snapshot for
// the "build the {slug} lander" spec chain. For a shipped
// [[lander_blueprints]] row, run the render QA (byte-identical copy, no
// broken image assets, structural parity) — see
// [[src/lib/blueprint-render-qa]] — and, on PASS, snapshot the live rendered
// URL onto the blueprint's `content.rendered_url` (via
// [[src/lib/lander-blueprints]] `setBlueprintRenderedUrl`).
//
// Two-phase — dry-run by default; --apply mutates:
//   npx tsx scripts/qa-and-snapshot-blueprint-render.ts                    # dry-run: prints QA report
//   npx tsx scripts/qa-and-snapshot-blueprint-render.ts --apply            # QA + snapshot the URL
//   npx tsx scripts/qa-and-snapshot-blueprint-render.ts <blueprint-id>     # override the default id
//   npx tsx scripts/qa-and-snapshot-blueprint-render.ts --url=<url>        # override the rendered URL
//
// The DEFAULT blueprint id + rendered URL are baked in for the amazing-coffee
// advertorial-listicle build (docs/brain/specs/lander-build-advertorial-listicle-amazing-coffee-23e0ea01.md).
// Pass a positional id + `--url=` to snapshot a different blueprint.
//
// Refuses to snapshot on ANY QA issue — a broken block would advertise a
// broken page. The founder unblocks by resolving the issues at their root
// (Carrie's copy write, the founder upload) and re-running --apply.
import { createAdminClient } from "./_bootstrap";
import { runBlueprintRenderQa } from "../src/lib/blueprint-render-qa";
import { setBlueprintRenderedUrl } from "../src/lib/lander-blueprints";

const DEFAULT_BLUEPRINT_ID = "23e0ea01-fea1-4aa2-90f3-bad2d856f654";
const DEFAULT_RENDERED_URL =
  "https://superfoods.com/amazing-coffee?variant=advertorial-listicle";

function parseArgs(): { apply: boolean; blueprintId: string; url: string } {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const urlArg = args.find((a) => a.startsWith("--url="));
  const url = urlArg ? urlArg.slice("--url=".length) : DEFAULT_RENDERED_URL;
  const blueprintId = args.find((a) => !a.startsWith("--")) || DEFAULT_BLUEPRINT_ID;
  return { apply, blueprintId, url };
}

async function main() {
  const { apply, blueprintId, url } = parseArgs();

  const admin = createAdminClient();
  const { data: bp, error } = await admin
    .from("lander_blueprints")
    .select("id, workspace_id, product_id, funnel_type, status, build_spec_slug")
    .eq("id", blueprintId)
    .maybeSingle();
  if (error) throw new Error(`blueprint read failed: ${error.message}`);
  if (!bp) throw new Error(`blueprint ${blueprintId} not found`);

  console.log("blueprint:");
  console.log(`  id            ${bp.id}`);
  console.log(`  workspace_id  ${bp.workspace_id}`);
  console.log(`  product_id    ${bp.product_id}`);
  console.log(`  funnel_type   ${bp.funnel_type}`);
  console.log(`  status        ${bp.status}`);
  console.log(`  build_spec    ${bp.build_spec_slug ?? "(none)"}`);
  console.log(`  rendered_url  ${url}`);
  console.log("");

  console.log("QA:");
  const report = await runBlueprintRenderQa(bp.workspace_id, bp.id);
  console.log(`  block count     ${report.blockCount}`);
  console.log(`  image blocks    ${report.imageBlockCount}`);
  console.log(`  issues          ${report.issues.length}`);
  for (const issue of report.issues) {
    console.log(`   • [${issue.kind}] ${issue.detail}`);
  }
  console.log(`  result          ${report.ok ? "PASS" : "FAIL"}`);
  console.log("");

  if (!report.ok) {
    console.error("QA failed — refusing to snapshot the rendered URL. Resolve the issues above and re-run.");
    process.exit(1);
  }

  if (!apply) {
    console.log("[dry-run] pass --apply to snapshot content.rendered_url onto the blueprint.");
    return;
  }

  await setBlueprintRenderedUrl(bp.workspace_id, bp.id, url);
  console.log(`✓ stamped content.rendered_url=${url} onto lander_blueprints ${bp.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
