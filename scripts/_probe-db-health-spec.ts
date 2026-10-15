import "./_bootstrap";
import { getSpec } from "../src/lib/specs-table";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "db-health-detector-measures-current-rate";

(async () => {
  // Read the spec + its phases through the specs-table SDK. `spec.phases` is
  // already ordered by the real `position` column.
  const spec = await getSpec(WS, SLUG);

  console.log("Spec:", spec ? { id: spec.id, slug: spec.slug, status: spec.status } : null);

  if (spec) {
    console.log("Phases:");
    for (const p of spec.phases ?? []) {
      console.log(`  Phase ${p.position} (${p.title}): ${p.status}`);
    }
  }
})();
