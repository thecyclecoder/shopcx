import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { Inngest } = await import("inngest");
  const inngest = new Inngest({
    id: "shopcx",
    eventKey: process.env.INNGEST_EVENT_KEY,
  });

  const result = await inngest.send({
    name: "marketing/klaviyo-sms.import",
    data: { workspace_id: W, history_days: 200 },
  });
  console.log("Fired:", result);
}

main().catch(e => { console.error(e); process.exit(1); });
