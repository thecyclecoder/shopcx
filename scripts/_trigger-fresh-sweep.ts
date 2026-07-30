import { loadEnv } from "./_bootstrap"; loadEnv();
import { inngest } from "@/lib/inngest/client";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const ids = await inngest.send({
    name: "ads/creative-scout.sweep",
    data: { workspaceId: WS, force: true },
  });
  console.log("sent ads/creative-scout.sweep (force=true) →", JSON.stringify(ids));
})().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
