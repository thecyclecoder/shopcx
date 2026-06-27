// apply-vercel-ignore-step-override — flip the Vercel project's commandForIgnoringBuildStep so
// `claude/*` build branches produce a preview deployment (preview-test-promote-pipeline M1).
//
// Calls patchIgnoredBuildStep() on src/lib/vercel-project.ts which:
//   - GETs the current command
//   - PATCHes only when it differs (idempotent — a second run is a no-op)
//   - logs the before/after for the audit trail
//
//   npx tsx scripts/apply-vercel-ignore-step-override.ts
import { loadEnv } from "./_bootstrap";

async function main() {
  loadEnv();
  const { patchIgnoredBuildStep, CLAUDE_PREVIEW_IGNORE_COMMAND } = await import("../src/lib/vercel-project");
  const result = await patchIgnoredBuildStep(CLAUDE_PREVIEW_IGNORE_COMMAND);
  console.log(JSON.stringify({ changed: result.changed, before: result.before, after: result.after }, null, 2));
}

main().catch((e) => {
  console.error("apply-vercel-ignore-step-override failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
