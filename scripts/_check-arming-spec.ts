/** Is the arming-feeds spec landed and moving through the pipeline? READ-ONLY (SDK reads). */
import "./_bootstrap";
import { whyIsSpecNotBuilding, whatIsSpecWaitingOn, whyDidSpecReviewFail } from "../src/lib/spec-investigation";
import { getSpec } from "../src/lib/specs-table";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "cold-scaler-arming-decides-on-evidence-not-absence";

async function main() {
  const spec = await getSpec(WS, SLUG);
  if (!spec) { console.log("spec not found"); return; }
  console.log(`${spec.slug}`);
  console.log(`  title    ${spec.title}`);
  console.log(`  owner    ${spec.owner} · status ${spec.status} · auto_build ${spec.auto_build}`);
  console.log(`  parent   ${String(spec.parent).slice(0, 110)}`);
  console.log(`  phases   ${(spec.phases ?? []).length}`);
  for (const p of spec.phases ?? []) {
    console.log(`    ${p.position}. [${p.status}] ${String(p.title).slice(0, 70)}`);
    console.log(`        checks: ${String(p.verification ?? "").split("\n").filter(Boolean).length} line(s)`);
  }

  console.log("\npipeline state:");
  for (const [label, fn] of [
    ["whyDidSpecReviewFail", whyDidSpecReviewFail],
    ["whatIsSpecWaitingOn", whatIsSpecWaitingOn],
    ["whyIsSpecNotBuilding", whyIsSpecNotBuilding],
  ] as const) {
    try {
      const r = await fn(WS, SLUG);
      console.log(`  ${label.padEnd(22)} ${JSON.stringify(r).slice(0, 240)}`);
    } catch (e) {
      console.log(`  ${label.padEnd(22)} error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
