import "./_bootstrap";
import { getSpec } from "../src/lib/specs-table";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "commerce-sdk-mutations-rename-subscription-prefix";

(async () => {
  // Read the spec + its phases through the specs-table SDK. `spec.phases` is
  // already ordered by the real `position` column.
  const spec = await getSpec(WS, SLUG);

  console.log("=== SPEC ROW ===");
  console.log(JSON.stringify(spec, null, 2));

  const phaseData = spec?.phases ?? [];

  console.log("\n=== SPEC_PHASES ===");
  console.log(JSON.stringify(phaseData, null, 2));

  // Phase status summary
  const statuses = phaseData.map((p) => ({ phase: p.position, status: p.status }));
  console.log("\nPhase statuses:", statuses);
  const allShipped = phaseData.length > 0 && phaseData.every((p) => p.status === "shipped");
  console.log("All phases shipped?", allShipped);
})();
