import { loadEnv } from "./_bootstrap";
loadEnv();
import { runCleoBlueprintSweep } from "../src/lib/cleo-blueprint";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const r = await runCleoBlueprintSweep(WS, { createdBy: null });
  console.log("SWEEP:", JSON.stringify(r, null, 2));
})().catch((e) => { console.error("SWEEP ERR", e instanceof Error ? e.message : e); process.exit(1); });
